package actions

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func init() {
	Register(&FsListAction{})
	Register(&FsReadAction{})
	Register(&FsUploadAction{})
}

// ═══════════════════════════════════════════════════════════════
// Constantes & politique de sécurité
// ═══════════════════════════════════════════════════════════════

const (
	// Cap de taille (lecture et upload). Au-delà, l'UI propose une
	// commande scp/rsync à la place. Voir docs phase 1.
	fsMaxSize int64 = 50 * 1024 * 1024 // 50 MB

	// Inbox où aboutissent les uploads. Owner nexus-agent, mode 0750.
	// L'utilisateur final se connecte en SSH et fait sudo mv pour déplacer.
	fsInboxDir = "/var/lib/nexus-agent/inbox"

	// Cap du nombre d'entrées renvoyées par fs.list. Au-delà on tronque
	// pour éviter de saturer le WS sur /usr/share par exemple.
	fsListMaxEntries = 2000
)

// Préfixes de chemin strictement refusés en lecture. Le but n'est pas
// d'empêcher un admin malicieux (l'agent tourne en privilégié), mais
// d'éviter qu'un click malheureux n'exfiltre des secrets via Nexus.
var fsDenyPathPrefixes = []string{
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers", // y compris /etc/sudoers.d/* (sauf cas dédié géré par agent.sudoers_check)
	"/root/.ssh/",
	// Répertoires de clés/secrets de l'agent Nexus. ATTENTION : le répertoire
	// réel des clés est /var/lib/nexus/keys (KEY_DIR dans install-agent.sh),
	// PAS /var/lib/nexus-agent/keys. shared.secret (clé AES du canal) y vit ;
	// sans ces préfixes un fs.read (autorisé en PROBE/READONLY) l'exfiltrerait.
	"/var/lib/nexus/keys/",
	"/var/lib/nexus/",
	"/opt/nexus/keys/",
	"/opt/nexus/",
	"/var/lib/nexus-agent/keys/",
	"/var/lib/nexus-agent/secrets/",
	"/proc/kcore",
	"/sys/firmware/efi/efivars",
}

// Pattern de chemin refusé (regex). Couvre /home/*/.ssh/id_* (clés
// privées utilisateur) sans avoir à lister chaque home.
var fsDenyPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^/home/[^/]+/\.ssh/id_`),
	regexp.MustCompile(`^/home/[^/]+/\.ssh/.*_rsa$`),
	regexp.MustCompile(`^/home/[^/]+/\.ssh/.*_ed25519$`),
	regexp.MustCompile(`^/home/[^/]+/\.ssh/.*_ecdsa$`),
}

// Extensions de fichiers refusées en lecture. Couvre les fichiers de
// clés et secrets qu'on ne veut pas voir transiter par Nexus.
var fsDenyExtensions = map[string]bool{
	".key":    true,
	".pem":    true,
	".pfx":    true,
	".p12":    true,
	".jks":    true,
	".gpg":    true,
	".asc":    true,
	".kdbx":   true,
	".secret": true, // shared.secret (clé AES du canal agent↔backend)
}

// Charset autorisé pour un nom de fichier uploadé. POSIX-safe, pas
// d'espaces (évite les pièges de quoting si l'utilisateur copie/colle).
var fsUploadFilenameRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// ═══════════════════════════════════════════════════════════════
// Helpers de validation de chemin
// ═══════════════════════════════════════════════════════════════

// resolvePath nettoie le chemin, refuse les chemins relatifs et les
// tentatives évidentes de traversal. Ne suit volontairement pas les
// symlinks (lstat) pour éviter qu'un /etc/foo -> /etc/shadow contourne
// la denylist.
func resolvePath(raw string) (string, os.FileInfo, error) {
	if raw == "" {
		return "", nil, errors.New("path required")
	}
	if !strings.HasPrefix(raw, "/") {
		return "", nil, errors.New("path must be absolute")
	}
	clean := filepath.Clean(raw)
	if strings.Contains(clean, "..") {
		return "", nil, errors.New("path traversal refused")
	}
	for _, prefix := range fsDenyPathPrefixes {
		if clean == prefix || strings.HasPrefix(clean, prefix) {
			return "", nil, fmt.Errorf("path denied by security policy: %s", clean)
		}
	}
	for _, pat := range fsDenyPatterns {
		if pat.MatchString(clean) {
			return "", nil, fmt.Errorf("path denied by security policy: %s", clean)
		}
	}
	info, err := os.Lstat(clean)
	if err != nil {
		return "", nil, fmt.Errorf("stat: %w", err)
	}
	// Défense en profondeur : Lstat ne résout que le dernier composant, donc un
	// symlink de répertoire PARENT (/tmp/x/shared.secret -> /var/lib/nexus/keys)
	// contournerait la denylist basée sur `clean`. On résout tous les symlinks
	// et on re-teste la cible réelle (préfixes + patterns + extension).
	if resolved, rerr := filepath.EvalSymlinks(clean); rerr == nil && resolved != clean {
		if isDenied(resolved) {
			return "", nil, fmt.Errorf("path denied by security policy (cible du lien): %s", resolved)
		}
	}
	return clean, info, nil
}

// modeString rend un mode à la "ls -l" (rwxrwxrwx). Plus lisible que
// l'octal sur la table frontend.
func modeString(m os.FileMode) string {
	const rwx = "rwxrwxrwx"
	out := []byte("---------")
	bits := uint32(m.Perm())
	for i := 0; i < 9; i++ {
		if bits&(1<<(8-i)) != 0 {
			out[i] = rwx[i]
		}
	}
	return string(out)
}

// kindOf classifie une FileInfo pour le frontend.
func kindOf(info os.FileInfo) string {
	mode := info.Mode()
	switch {
	case mode&os.ModeSymlink != 0:
		return "symlink"
	case mode.IsDir():
		return "dir"
	case mode&os.ModeDevice != 0:
		return "device"
	case mode&os.ModeNamedPipe != 0:
		return "pipe"
	case mode&os.ModeSocket != 0:
		return "socket"
	case mode.IsRegular():
		return "file"
	default:
		return "other"
	}
}

// ═══════════════════════════════════════════════════════════════
// fs.list — liste les entrées d'un répertoire
// ═══════════════════════════════════════════════════════════════

type FsListAction struct{}

func (a *FsListAction) ID() string         { return "fs.list" }
func (a *FsListAction) Capability() string { return "monitoring" }
func (a *FsListAction) Validate(params map[string]interface{}) error {
	if _, ok := params["path"].(string); !ok {
		return errors.New("required parameter 'path' missing or not a string")
	}
	return nil
}

type fsEntry struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	Mtime   string `json:"mtime"`
	Denied  bool   `json:"denied,omitempty"`  // refusé par la politique de sécurité
	Symlink string `json:"symlink,omitempty"` // cible du symlink, pour info
}

func (a *FsListAction) Execute(params map[string]interface{}) (interface{}, error) {
	raw, _ := params["path"].(string)
	path, info, err := resolvePath(raw)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("not a directory: %s", path)
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}

	result := make([]fsEntry, 0, len(entries))
	truncated := false
	for i, e := range entries {
		if i >= fsListMaxEntries {
			truncated = true
			break
		}
		full := filepath.Join(path, e.Name())
		info, err := os.Lstat(full)
		if err != nil {
			// Une entrée inaccessible : on la liste avec denied=true plutôt
			// que d'échouer toute la requête.
			result = append(result, fsEntry{Name: e.Name(), Denied: true})
			continue
		}
		entry := fsEntry{
			Name:  e.Name(),
			Kind:  kindOf(info),
			Size:  info.Size(),
			Mode:  modeString(info.Mode()),
			Mtime: info.ModTime().UTC().Format(time.RFC3339),
		}
		// Marquer les entrées denied par la politique (ne pas exposer le contenu,
		// mais l'utilisateur voit qu'elles existent — moins surprenant).
		if isDenied(full) {
			entry.Denied = true
		}
		if entry.Kind == "symlink" {
			if target, lerr := os.Readlink(full); lerr == nil {
				entry.Symlink = target
			}
		}
		result = append(result, entry)
	}

	return map[string]interface{}{
		"path":      path,
		"entries":   result,
		"count":     len(result),
		"truncated": truncated,
		"inbox":     fsInboxDir, // pour que l'UI sache où autoriser l'upload
	}, nil
}

// isDenied réplique la logique de denylist sans renvoyer d'erreur.
// Utilisé pour marquer dans le listing.
func isDenied(path string) bool {
	for _, prefix := range fsDenyPathPrefixes {
		if path == prefix || strings.HasPrefix(path, prefix) {
			return true
		}
	}
	for _, pat := range fsDenyPatterns {
		if pat.MatchString(path) {
			return true
		}
	}
	if ext := strings.ToLower(filepath.Ext(path)); fsDenyExtensions[ext] {
		return true
	}
	return false
}

// ═══════════════════════════════════════════════════════════════
// fs.read — lit un fichier en base64 (cap 50 MB)
// ═══════════════════════════════════════════════════════════════

type FsReadAction struct{}

func (a *FsReadAction) ID() string         { return "fs.read" }
func (a *FsReadAction) Capability() string { return "monitoring" }
func (a *FsReadAction) Validate(params map[string]interface{}) error {
	if _, ok := params["path"].(string); !ok {
		return errors.New("required parameter 'path' missing or not a string")
	}
	return nil
}

func (a *FsReadAction) Execute(params map[string]interface{}) (interface{}, error) {
	raw, _ := params["path"].(string)
	path, info, err := resolvePath(raw)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("symlink read refused (resolve target manually)")
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file: %s", path)
	}
	if ext := strings.ToLower(filepath.Ext(path)); fsDenyExtensions[ext] {
		return nil, fmt.Errorf("extension denied by security policy: %s", ext)
	}
	if info.Size() > fsMaxSize {
		return nil, fmt.Errorf("file too large: %d bytes (max %d). Use scp/rsync instead.", info.Size(), fsMaxSize)
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	// Stream vers buffer + sha256 en simultané. Pour 50 MB ça reste OK
	// en RAM (~50 MB) et donne un hash que le client peut vérifier.
	hasher := sha256.New()
	content, err := io.ReadAll(io.TeeReader(f, hasher))
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}

	return map[string]interface{}{
		"path":           path,
		"size":           info.Size(),
		"mtime":          info.ModTime().UTC().Format(time.RFC3339),
		"sha256":         hex.EncodeToString(hasher.Sum(nil)),
		"content_base64": base64.StdEncoding.EncodeToString(content),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// fs.upload — écrit un fichier dans l'inbox (NON exécutable, mode 0640)
// ═══════════════════════════════════════════════════════════════

type FsUploadAction struct{}

func (a *FsUploadAction) ID() string         { return "fs.upload" }
func (a *FsUploadAction) Capability() string { return "file_management" }
func (a *FsUploadAction) Validate(params map[string]interface{}) error {
	name, ok := params["filename"].(string)
	if !ok || !fsUploadFilenameRegex.MatchString(name) {
		return errors.New("invalid 'filename': must match [A-Za-z0-9._-]{1,128}")
	}
	content, ok := params["content_base64"].(string)
	if !ok || content == "" {
		return errors.New("required parameter 'content_base64' missing")
	}
	// Estimation rapide de la taille (base64 = ~4/3 du binaire) avant
	// de décoder pour rejeter tôt les payloads abusifs.
	if int64(len(content))*3/4 > fsMaxSize+1024 {
		return fmt.Errorf("payload too large (max %d bytes). Use scp/rsync instead.", fsMaxSize)
	}
	return nil
}

func (a *FsUploadAction) Execute(params map[string]interface{}) (interface{}, error) {
	name, _ := params["filename"].(string)
	contentB64, _ := params["content_base64"].(string)

	content, err := base64.StdEncoding.DecodeString(contentB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64: %w", err)
	}
	if int64(len(content)) > fsMaxSize {
		return nil, fmt.Errorf("file too large: %d bytes (max %d)", len(content), fsMaxSize)
	}

	if err := os.MkdirAll(fsInboxDir, 0o750); err != nil {
		return nil, fmt.Errorf("ensure inbox: %w", err)
	}

	// Auto-suffixe en cas de collision : rapport.txt, rapport-1.txt, rapport-2.txt
	// Le user a explicitement choisi ce comportement plutôt que l'écrasement.
	target := filepath.Join(fsInboxDir, name)
	finalPath := target
	if _, err := os.Stat(target); err == nil {
		ext := filepath.Ext(name)
		stem := strings.TrimSuffix(name, ext)
		for i := 1; i < 1000; i++ {
			candidate := filepath.Join(fsInboxDir, fmt.Sprintf("%s-%d%s", stem, i, ext))
			if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
				finalPath = candidate
				break
			}
		}
		if finalPath == target {
			return nil, errors.New("too many name collisions (>1000) in inbox")
		}
	}

	// O_CREATE|O_EXCL pour fermer la fenêtre TOCTOU entre Stat() ci-dessus
	// et l'écriture. Mode 0640 explicite : NON exécutable.
	f, err := os.OpenFile(finalPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return nil, fmt.Errorf("create: %w", err)
	}
	written, werr := f.Write(content)
	cerr := f.Close()
	if werr != nil {
		_ = os.Remove(finalPath)
		return nil, fmt.Errorf("write: %w", werr)
	}
	if cerr != nil {
		_ = os.Remove(finalPath)
		return nil, fmt.Errorf("close: %w", cerr)
	}

	// Hash pour audit
	hasher := sha256.New()
	hasher.Write(content)

	return map[string]interface{}{
		"path":     finalPath,
		"filename": filepath.Base(finalPath),
		"size":     written,
		"sha256":   hex.EncodeToString(hasher.Sum(nil)),
		"inbox":    fsInboxDir,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// CleanupInbox — supprime les fichiers de l'inbox > 7 jours
// Appelé périodiquement par le main loop.
// ═══════════════════════════════════════════════════════════════

const fsInboxTTL = 7 * 24 * time.Hour

func CleanupInbox() (removed int, err error) {
	entries, err := os.ReadDir(fsInboxDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	cutoff := time.Now().Add(-fsInboxTTL)
	for _, e := range entries {
		full := filepath.Join(fsInboxDir, e.Name())
		info, lerr := os.Lstat(full)
		if lerr != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if rerr := os.Remove(full); rerr == nil {
				removed++
			}
		}
	}
	return removed, nil
}
