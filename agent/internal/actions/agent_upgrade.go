package actions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"aead.dev/minisign"
)

// RunningVersion est la version de l'agent EN COURS d'exécution (injectée via
// main.Version au build, propagée par main.go au démarrage). "dev" = build local
// non estampillé. Sert de plancher anti-rollback (NEXUS-SELF-UPGRADE-002).
var RunningVersion = "dev"

// PinnedServerURL est l'URL du backend ENRÔLÉ (cfg.ServerURL, wss://host/…),
// propagée par main.go. L'auto-upgrade n'accepte de télécharger (et d'envoyer son
// token bearer) QUE vers cet hôte, en https (NEXUS-SELF-UPGRADE-003).
var PinnedServerURL string

// validateDownloadURL épingle l'origine du download sur le backend pinné : https
// + même hôte + chemin /api/agents/download. Renvoie l'erreur AVANT que le token
// bearer ne soit attaché ou la requête émise.
func validateDownloadURL(downloadURL string) error {
	pinned, perr := url.Parse(PinnedServerURL)
	if perr != nil || pinned.Host == "" {
		return fmt.Errorf("URL serveur pinnée indisponible/invalide")
	}
	du, derr := url.Parse(downloadURL)
	if derr != nil {
		return fmt.Errorf("download_url invalide : %w", derr)
	}
	if du.Scheme != "https" {
		return fmt.Errorf("download_url doit être https:// (origine pinnée), schéma=%q", du.Scheme)
	}
	if !strings.EqualFold(du.Host, pinned.Host) {
		return fmt.Errorf("download_url hôte non pinné : %q (attendu %q)", du.Host, pinned.Host)
	}
	if !strings.HasPrefix(du.Path, "/api/agents/download") {
		return fmt.Errorf("download_url chemin non autorisé : %q", du.Path)
	}
	return nil
}

// parseSemver extrait (major, minor, patch) d'une version "X.Y.Z[-N-gSHA][+meta]".
// ok=false si non parsable (ex. "dev", version vide).
func parseSemver(v string) (maj, min, pat int, ok bool) {
	core := strings.TrimSpace(v)
	if i := strings.IndexAny(core, "-+"); i >= 0 {
		core = core[:i]
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	var err error
	if maj, err = strconv.Atoi(parts[0]); err != nil {
		return 0, 0, 0, false
	}
	if min, err = strconv.Atoi(parts[1]); err != nil {
		return 0, 0, 0, false
	}
	if pat, err = strconv.Atoi(parts[2]); err != nil {
		return 0, 0, 0, false
	}
	return maj, min, pat, true
}

// isDowngrade renvoie true si target < current (comparaison semver). Si l'une des
// deux versions n'est pas parsable (ex. current "dev"), on NE bloque PAS — le
// build dev / version inconnue n'a pas de plancher.
func isDowngrade(target, current string) bool {
	tm, tn, tp, tok := parseSemver(target)
	cm, cn, cp, cok := parseSemver(current)
	if !tok || !cok {
		return false
	}
	if tm != cm {
		return tm < cm
	}
	if tn != cn {
		return tn < cn
	}
	return tp < cp
}

func init() { Register(&AgentUpgradeAction{}) }

// OnAgentUpgradeProgress est appelé à chaque étape de la mise à jour de
// l'agent (téléchargement, vérification, installation, redémarrage). Branché
// par main.go pour streamer la progression vers le backend (agent.upgrade.progress).
// Distinct de OnUpdateProgress (MAJ système apt) : contexte UI différent.
var OnAgentUpgradeProgress func(line string, percent int)

func upgradeProgress(line string, percent int) {
	if OnAgentUpgradeProgress != nil {
		OnAgentUpgradeProgress(line, percent)
	}
}

// releasePubKeyPath est l'accept-list minisign des clés publiques de release,
// déposée par l'OPÉRATEUR à l'installation (root:root 0644, sibling de
// server-public-key.pem). Elle est LOCALE et de confiance ; le backend n'y
// touche jamais — c'est ce qui rend l'authenticité de l'auto-upgrade
// indépendante du canal de commande (un backend compromis ne détient pas la
// clé privée hors-ligne et ne peut donc pas signer un binaire trojané).
const releasePubKeyPath = "/etc/nexus/release.pub"

// loadReleasePubKeys lit et parse l'accept-list locale : une clé publique
// minisign par ligne non vide. Les lignes vides, les commentaires (`#`) et la
// ligne d'en-tête `untrusted comment:` d'un fichier .pub collé tel quel sont
// ignorés. La fonction renvoie TOUJOURS une erreur plutôt qu'une liste vide
// silencieuse, de sorte que l'appelant échoue fermé : fichier absent, illisible,
// vide ou contenant une clé non parsable ⇒ erreur ⇒ upgrade refusé. Aucune
// variable d'env, aucun flag, aucun fallback.
func loadReleasePubKeys() ([]minisign.PublicKey, error) {
	data, err := os.ReadFile(releasePubKeyPath)
	if err != nil {
		return nil, fmt.Errorf("lecture %s : %w", releasePubKeyPath, err)
	}
	var keys []minisign.PublicKey
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "untrusted comment:") {
			continue
		}
		var pk minisign.PublicKey
		if err := pk.UnmarshalText([]byte(line)); err != nil {
			return nil, fmt.Errorf("clé publique invalide dans %s : %w", releasePubKeyPath, err)
		}
		keys = append(keys, pk) // accept-list = liste dès la 1re entrée (current[, next] pour la rotation)
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("%s ne contient aucune clé publique utilisable", releasePubKeyPath)
	}
	return keys, nil
}

// verifyAnyReleaseKey applique un OR logique sur l'accept-list : la signature
// minisign détachée est acceptée si N'IMPORTE quelle clé de la liste la valide.
// minisign.Verify gère de façon transparente le format brut (Ed) comme le format
// pré-hashé Blake2b-512 (ED), et vérifie aussi la signature globale du trusted
// comment.
func verifyAnyReleaseKey(keys []minisign.PublicKey, message, sig []byte) bool {
	for _, pk := range keys {
		if minisign.Verify(pk, message, sig) {
			return true
		}
	}
	return false
}

// AgentUpgradeAction met a jour le binaire de l'agent lui-meme.
// Flow :
//   1. Telecharge le nouveau binaire dans /var/lib/nexus-agent/nexus-agent.new
//   2. Verifie le SHA256 (si fourni)
//   3. sudo install -m 755 pour remplacer /usr/local/bin/nexus-agent
//   4. Retourne ACK
//   5. os.Exit(0) apres un bref delai
//   6. systemd (Restart=always) relance le service avec le nouveau binaire
type AgentUpgradeAction struct{}

func (a *AgentUpgradeAction) ID() string         { return "agent.upgrade" }
func (a *AgentUpgradeAction) Capability() string { return "monitoring" } // toujours disponible

func (a *AgentUpgradeAction) Validate(params map[string]interface{}) error {
	if _, ok := params["download_url"].(string); !ok {
		return fmt.Errorf("required parameter 'download_url' missing")
	}
	if _, ok := params["token"].(string); !ok {
		return fmt.Errorf("required parameter 'token' missing")
	}
	return nil
}

func (a *AgentUpgradeAction) Execute(params map[string]interface{}) (interface{}, error) {
	downloadURL := params["download_url"].(string)
	token := params["token"].(string)
	expectedSHA256, _ := params["sha256"].(string)
	signature, _ := params["signature"].(string)

	// ---- POINT DE DÉCISION FAIL-CLOSED UNIQUE (indépendant du canal) ----
	// Le binaire installé doit être signé par une clé de release HORS-LIGNE dont
	// la moitié publique est déposée LOCALEMENT par l'opérateur (release.pub,
	// root:root 0644). Le backend ne fournit jamais cette clé : il signe le canal
	// WS, sert le binaire et son SHA, mais ne détient pas la clé privée hors-ligne
	// — il ne peut donc pas pousser de code. On charge l'accept-list locale
	// d'abord ; absence/illisibilité/vacuité ⇒ refus, sans échappatoire.
	releaseKeys, err := loadReleasePubKeys()
	if err != nil {
		return nil, fmt.Errorf("clé(s) de release introuvable(s)/invalide(s) : mise à jour refusée : %w", err)
	}
	// Le SHA-256 fourni par le backend reste un PRÉ-CHECK de corruption transit,
	// JAMAIS l'autorité de validation : l'autorité est la signature minisign
	// vérifiée plus bas contre la clé locale. Un sha256 vide = backend incohérent.
	if expectedSHA256 == "" {
		return nil, fmt.Errorf("sha256 attendu manquant : mise à jour refusée (intégrité non vérifiable)")
	}
	// La signature détachée est obligatoire (relayée par le backend depuis le
	// .minisig servi à côté du binaire ; le backend la transporte mais ne peut
	// pas la forger sans la clé privée hors-ligne).
	if signature == "" {
		return nil, fmt.Errorf("signature de release manquante : mise à jour refusée")
	}

	// NEXUS-SELF-UPGRADE-002 — anti-rollback (plancher de version). Même un binaire
	// validement SIGNÉ d'une ancienne release reste signé à vie → la signature seule
	// n'empêche pas un downgrade vers une version vulnérable. On exige la version
	// cible et on refuse target < courant, sauf break-glass explicite et tracé.
	target, _ := params["target_version"].(string)
	allowDowngrade, _ := params["allow_downgrade"].(bool)
	if target == "" {
		return nil, fmt.Errorf("target_version manquant : mise à jour refusée (anti-rollback)")
	}
	if isDowngrade(target, RunningVersion) {
		if !allowDowngrade {
			return nil, fmt.Errorf("downgrade refusé : cible %s < courant %s (allow_downgrade explicite requis)", target, RunningVersion)
		}
		upgradeProgress(fmt.Sprintf("⚠️ DOWNGRADE explicite %s → %s (allow_downgrade)", RunningVersion, target), 5)
	}

	// NEXUS-SELF-UPGRADE-003 — épingler l'origine AVANT d'envoyer le token bearer :
	// un download_url vers un hôte arbitraire exfiltrerait le token et ferait de
	// chaque agent un pivot SSRF (endpoints internes / metadata cloud).
	if err := validateDownloadURL(downloadURL); err != nil {
		return nil, fmt.Errorf("origine de téléchargement refusée : %w", err)
	}

	newBinPath := "/var/lib/nexus-agent/nexus-agent.new"
	finalBinPath := "/usr/local/bin/nexus-agent"

	// S'assurer que le dossier existe (StateDirectory devrait l'avoir cree)
	os.MkdirAll("/var/lib/nexus-agent", 0700)

	// 1. Telecharger. Token en header Authorization (pas en query : évite la
	// fuite du token dans les logs d'accès proxy/reverse-proxy).
	upgradeProgress("Téléchargement du nouveau binaire…", 10)
	req, err := http.NewRequest("GET", downloadURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}

	out, err := os.Create(newBinPath)
	if err != nil {
		return nil, fmt.Errorf("create file: %w", err)
	}

	hasher := sha256.New()
	w := io.MultiWriter(out, hasher)
	written, err := io.Copy(w, resp.Body)
	out.Close()
	if err != nil {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("write binary: %w", err)
	}

	actualSHA256 := hex.EncodeToString(hasher.Sum(nil))
	upgradeProgress(fmt.Sprintf("Téléchargé : %d octets", written), 45)

	// 2. Pré-check SHA256 (corruption transit uniquement, NON autorité).
	upgradeProgress("Vérification de l'intégrité (SHA256)…", 55)
	if expectedSHA256 != actualSHA256 {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("sha256 mismatch: expected %s, got %s", expectedSHA256, actualSHA256)
	}

	// 2b. AUTORITÉ DE VALIDATION : signature minisign détachée du binaire
	// téléchargé, vérifiée contre l'accept-list LOCALE, AVANT toute installation.
	// Indépendante du canal : même un backend entièrement compromis ne peut pas
	// faire passer un binaire non signé par la clé hors-ligne de l'opérateur.
	upgradeProgress("Vérification de la signature de release…", 65)
	staged, err := os.ReadFile(newBinPath) // fenêtre verify→install : TOCTOU traitée par SELF-UPGRADE-004
	if err != nil {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("relecture du binaire stagé : %w", err)
	}
	if !verifyAnyReleaseKey(releaseKeys, staged, []byte(signature)) {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("signature de release invalide : mise à jour refusée")
	}

	// chmod +x
	if err := os.Chmod(newBinPath, 0755); err != nil {
		return nil, fmt.Errorf("chmod: %w", err)
	}

	// SELF-UPGRADE-002 — lier l'assertion de version à l'ARTEFACT vérifié, pas juste
	// au param : lire la version du binaire (maintenant SIGNÉ → exécution sûre) et
	// exiger qu'elle == la cible signée. Empêche un backend de prétendre une version
	// tout en servant un autre binaire (signé) plus ancien.
	verOut, verErr := exec.Command(newBinPath, "--version").Output()
	gotVer := strings.TrimSpace(string(verOut))
	if verErr != nil || gotVer != strings.TrimSpace(target) {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("version du binaire (%q) ≠ cible signée %q : mise à jour refusée", gotVer, target)
	}

	// SELF-UPGRADE-004 (anti-TOCTOU, front) — re-hash le binaire stagé IMMÉDIATEMENT
	// avant install : si nexus-agent l'a swappé depuis la vérif signature, l'install
	// ne copierait pas les octets vérifiés. Mismatch → refus.
	recheck, rerr := os.ReadFile(newBinPath)
	if rerr != nil {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("relecture pré-install : %w", rerr)
	}
	rh := sha256.Sum256(recheck)
	if hex.EncodeToString(rh[:]) != actualSHA256 {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("binaire stagé modifié avant install (TOCTOU) : mise à jour refusée")
	}

	// 3. Remplacer le binaire actuel via sudo install (atomic)
	upgradeProgress("Installation du binaire (atomique)…", 75)
	cmd := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", newBinPath, finalBinPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("install failed: %w: %s", err, string(output))
	}

	// SELF-UPGRADE-004 (anti-TOCTOU, back) — re-vérifier le binaire INSTALLÉ avant
	// de redémarrer dedans : on lit /usr/local/bin/nexus-agent et on exige que son
	// SHA == celui vérifié. Sinon on REFUSE l'exit (pas de redémarrage dans un
	// binaire trafiqué), même si l'install a "réussi".
	installed, ierr := os.ReadFile(finalBinPath)
	if ierr != nil {
		return nil, fmt.Errorf("relecture du binaire installé : %w", ierr)
	}
	ih := sha256.Sum256(installed)
	installedSHA := hex.EncodeToString(ih[:])
	if installedSHA != actualSHA256 {
		return nil, fmt.Errorf("binaire installé (%s) ≠ vérifié (%s) : redémarrage REFUSÉ (TOCTOU)", installedSHA, actualSHA256)
	}

	// Nettoyer le fichier temporaire
	os.Remove(newBinPath)

	// 4. Lancer un exit differe (apres avoir retourne la reponse)
	// systemd va redemarrer l'agent (Restart=always) avec le nouveau binaire.
	upgradeProgress("Installé. Redémarrage de l'agent dans 2s…", 90)
	go func() {
		time.Sleep(2 * time.Second)
		os.Exit(0)
	}()

	return map[string]interface{}{
		"success":        true,
		"downloaded":     written,
		"sha256":         actualSHA256,
		"installed_to":   finalBinPath,
		"restart_in_sec": 2,
	}, nil
}
