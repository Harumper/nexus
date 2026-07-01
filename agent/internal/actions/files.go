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
// Constants & security policy
// ═══════════════════════════════════════════════════════════════

const (
	// Size cap (read and upload). Beyond it, the UI proposes a
	// scp/rsync command instead. See phase 1 docs.
	fsMaxSize int64 = 50 * 1024 * 1024 // 50 MB

	// Inbox where uploads land. Owner nexus-agent, mode 0750.
	// The end user connects via SSH and does sudo mv to move the file.
	fsInboxDir = "/var/lib/nexus-agent/inbox"

	// Cap on the number of entries returned by fs.list. Beyond it we truncate
	// to avoid saturating the WS on /usr/share for example.
	fsListMaxEntries = 2000
)

// Path prefixes strictly refused for reading. The goal is not to
// stop a malicious admin (the agent runs privileged), but
// to prevent an unfortunate click from exfiltrating secrets via Nexus.
var fsDenyPathPrefixes = []string{
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers", // including /etc/sudoers.d/* (except the dedicated case handled by agent.sudoers_check)
	"/root/.ssh/",
	// Key/secret directories of the Nexus agent. WARNING: the
	// actual keys directory is /var/lib/nexus/keys (KEY_DIR in install-agent.sh),
	// NOT /var/lib/nexus-agent/keys. shared.secret (channel AES key) lives there;
	// without these prefixes an fs.read (read-only action) would exfiltrate it.
	"/var/lib/nexus/keys/",
	"/var/lib/nexus/",
	"/opt/nexus/keys/",
	"/opt/nexus/",
	"/var/lib/nexus-agent/keys/",
	"/var/lib/nexus-agent/secrets/",
	"/proc/kcore",
	"/sys/firmware/efi/efivars",
}

// Refused path pattern (regex). Covers /home/*/.ssh/id_* (user
// private keys) without having to list each home.
var fsDenyPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^/home/[^/]+/\.ssh/id_`),
	regexp.MustCompile(`^/home/[^/]+/\.ssh/.*_rsa$`),
	regexp.MustCompile(`^/home/[^/]+/\.ssh/.*_ed25519$`),
	regexp.MustCompile(`^/home/[^/]+/\.ssh/.*_ecdsa$`),
}

// File extensions refused for reading. Covers key and secret
// files that we do not want transiting through Nexus.
var fsDenyExtensions = map[string]bool{
	".key":    true,
	".pem":    true,
	".pfx":    true,
	".p12":    true,
	".jks":    true,
	".gpg":    true,
	".asc":    true,
	".kdbx":   true,
	".secret": true, // shared.secret (AES key of the agent↔backend channel)
}

// Allowed charset for an uploaded filename. POSIX-safe, no
// spaces (avoids quoting pitfalls if the user copies/pastes).
var fsUploadFilenameRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// ═══════════════════════════════════════════════════════════════
// Path validation helpers
// ═══════════════════════════════════════════════════════════════

// resolvePath cleans the path, refuses relative paths and
// obvious traversal attempts. Deliberately does not follow
// symlinks (lstat) to prevent a /etc/foo -> /etc/shadow from bypassing
// the denylist.
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
	// Defense in depth: Lstat only resolves the last component, so a
	// PARENT directory symlink (/tmp/x/shared.secret -> /var/lib/nexus/keys)
	// would bypass the denylist based on `clean`. We resolve all symlinks
	// and re-test the actual target (prefixes + patterns + extension).
	if resolved, rerr := filepath.EvalSymlinks(clean); rerr == nil && resolved != clean {
		if isDenied(resolved) {
			return "", nil, fmt.Errorf("path denied by security policy (link target): %s", resolved)
		}
	}
	return clean, info, nil
}

// modeString renders a mode "ls -l" style (rwxrwxrwx). More readable than
// octal in the frontend table.
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

// kindOf classifies a FileInfo for the frontend.
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
// fs.list — lists the entries of a directory
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
	Denied  bool   `json:"denied,omitempty"`  // refused by the security policy
	Symlink string `json:"symlink,omitempty"` // symlink target, for info
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
			// An inaccessible entry: we list it with denied=true rather
			// than failing the whole request.
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
		// Mark entries denied by the policy (do not expose the content,
		// but the user sees that they exist — less surprising).
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
		"inbox":     fsInboxDir, // so the UI knows where to allow upload
	}, nil
}

// isDenied replicates the denylist logic without returning an error.
// Used to mark entries in the listing.
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
// fs.read — reads a file as base64 (cap 50 MB)
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

	// Stream to buffer + sha256 simultaneously. For 50 MB it stays OK
	// in RAM (~50 MB) and gives a hash the client can verify.
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
// fs.upload — writes a file into the inbox (NON-executable, mode 0640)
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
	// Quick size estimate (base64 = ~4/3 of the binary) before
	// decoding, to reject abusive payloads early.
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

	// Auto-suffix on collision: rapport.txt, rapport-1.txt, rapport-2.txt
	// The user explicitly chose this behavior over overwriting.
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

	// O_CREATE|O_EXCL to close the TOCTOU window between Stat() above
	// and the write. Explicit mode 0640: NON-executable.
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

	// Hash for audit
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
// CleanupInbox — removes inbox files older than 7 days
// Called periodically by the main loop.
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
