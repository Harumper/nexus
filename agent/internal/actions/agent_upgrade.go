package actions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"aead.dev/minisign"
)

// RunningVersion is the version of the agent CURRENTLY running (injected via
// main.Version at build, propagated by main.go at startup). "dev" = local build
// not stamped. Serves as the anti-rollback floor (NEXUS-SELF-UPGRADE-002).
var RunningVersion = "dev"

// PinnedServerURL is the URL of the ENROLLED backend (cfg.ServerURL, wss://host/…),
// propagated by main.go. Auto-upgrade only accepts to download (and to send its
// bearer token) TO that host, over https (NEXUS-SELF-UPGRADE-003).
var PinnedServerURL string

// validateDownloadURL pins the download origin to the pinned backend: https
// + same host + path /api/agents/download. Returns the error BEFORE the bearer
// token is attached or the request is issued.
func validateDownloadURL(downloadURL string) error {
	pinned, perr := url.Parse(PinnedServerURL)
	if perr != nil || pinned.Host == "" {
		return fmt.Errorf("pinned server URL unavailable/invalid")
	}
	du, derr := url.Parse(downloadURL)
	if derr != nil {
		return fmt.Errorf("invalid download_url: %w", derr)
	}
	if du.Scheme != "https" {
		return fmt.Errorf("download_url must be https:// (pinned origin), scheme=%q", du.Scheme)
	}
	if !strings.EqualFold(du.Host, pinned.Host) {
		return fmt.Errorf("download_url host not pinned: %q (expected %q)", du.Host, pinned.Host)
	}
	if !strings.HasPrefix(du.Path, "/api/agents/download") {
		return fmt.Errorf("download_url path not allowed: %q", du.Path)
	}
	return nil
}

// parseSemver extracts (major, minor, patch) from a version "X.Y.Z[-N-gSHA][+meta]".
// ok=false if not parsable (e.g. "dev", empty version).
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

// isDowngrade returns true if target < current (semver comparison). If either
// of the two versions is not parsable (e.g. current "dev"), we do NOT block — the
// dev build / unknown version has no floor.
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

// OnAgentUpgradeProgress is called at each step of the agent update
// (download, verification, installation, restart). Wired
// by main.go to stream progress to the backend (agent.upgrade.progress).
// Distinct from OnUpdateProgress (apt system update): different UI context.
var OnAgentUpgradeProgress func(line string, percent int)

func upgradeProgress(line string, percent int) {
	if OnAgentUpgradeProgress != nil {
		OnAgentUpgradeProgress(line, percent)
	}
}

// releasePubKeyPath is the minisign accept-list of release public keys,
// placed by the OPERATOR at install time (root:root 0644, sibling of
// server-public-key.pem). It is LOCAL and trusted; the backend never
// touches it — this is what makes the authenticity of auto-upgrade
// independent of the command channel (a compromised backend does not hold the
// offline private key and therefore cannot sign a trojaned binary).
const releasePubKeyPath = "/etc/nexus/release.pub"

// loadReleasePubKeys reads and parses the local accept-list: one minisign
// public key per non-empty line. Empty lines, comments (`#`) and the
// `untrusted comment:` header line of a .pub file pasted as-is are
// ignored. The function ALWAYS returns an error rather than a silent empty
// list, so the caller fails closed: missing, unreadable,
// empty file, or a file containing an unparsable key ⇒ error ⇒ upgrade refused. No
// env variable, no flag, no fallback.
func loadReleasePubKeys() ([]minisign.PublicKey, error) {
	data, err := os.ReadFile(releasePubKeyPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", releasePubKeyPath, err)
	}
	var keys []minisign.PublicKey
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "untrusted comment:") {
			continue
		}
		var pk minisign.PublicKey
		if err := pk.UnmarshalText([]byte(line)); err != nil {
			return nil, fmt.Errorf("invalid public key in %s: %w", releasePubKeyPath, err)
		}
		keys = append(keys, pk) // accept-list = list from the 1st entry (current[, next] for rotation)
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("%s contains no usable public key", releasePubKeyPath)
	}
	return keys, nil
}

// verifyAnyReleaseKey applies a logical OR over the accept-list: the detached
// minisign signature is accepted if ANY key in the list validates it.
// minisign.Verify transparently handles the raw format (Ed) as well as the
// pre-hashed Blake2b-512 format (ED), and also verifies the global signature of the
// trusted comment.
func verifyAnyReleaseKey(keys []minisign.PublicKey, message, sig []byte) bool {
	for _, pk := range keys {
		if minisign.Verify(pk, message, sig) {
			return true
		}
	}
	return false
}

// AgentUpgradeAction updates the agent binary itself.
// Flow:
//  1. Downloads the new binary to /var/lib/nexus-agent/nexus-agent.new
//  2. Verifies the SHA256 (if provided)
//  3. sudo install -m 755 to replace /usr/local/bin/nexus-agent
//  4. Returns ACK
//  5. os.Exit(0) after a brief delay
//  6. systemd (Restart=always) restarts the service with the new binary
type AgentUpgradeAction struct{}

func (a *AgentUpgradeAction) ID() string         { return "agent.upgrade" }
func (a *AgentUpgradeAction) Capability() string { return "monitoring" } // always available

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

	// ---- SINGLE FAIL-CLOSED DECISION POINT (channel-independent) ----
	// The installed binary must be signed by an OFFLINE release key whose
	// public half is placed LOCALLY by the operator (release.pub,
	// root:root 0644). The backend never provides this key: it signs the WS
	// channel, serves the binary and its SHA, but does not hold the offline private key
	// — so it cannot push code. We load the local accept-list
	// first; absence/unreadability/emptiness ⇒ refusal, no escape hatch.
	releaseKeys, err := loadReleasePubKeys()
	if err != nil {
		return nil, fmt.Errorf("release key(s) not found/invalid: update refused: %w", err)
	}
	// The SHA-256 provided by the backend remains a PRE-CHECK for transit corruption,
	// NEVER the validation authority: the authority is the minisign signature
	// verified below against the local key. An empty sha256 = inconsistent backend.
	if expectedSHA256 == "" {
		return nil, fmt.Errorf("expected sha256 missing: update refused (integrity not verifiable)")
	}
	// The detached signature is mandatory (relayed by the backend from the
	// .minisig served alongside the binary; the backend transports it but cannot
	// forge it without the offline private key).
	if signature == "" {
		return nil, fmt.Errorf("release signature missing: update refused")
	}

	// NEXUS-SELF-UPGRADE-002 — anti-rollback (version floor). Even a validly
	// SIGNED binary of an old release stays signed forever → the signature alone
	// does not prevent a downgrade to a vulnerable version. We require the target
	// version and refuse target < current, except for an explicit and logged break-glass.
	target, _ := params["target_version"].(string)
	allowDowngrade, _ := params["allow_downgrade"].(bool)
	if target == "" {
		return nil, fmt.Errorf("target_version missing: update refused (anti-rollback)")
	}
	if isDowngrade(target, RunningVersion) {
		if !allowDowngrade {
			return nil, fmt.Errorf("downgrade refused: target %s < current %s (explicit allow_downgrade required)", target, RunningVersion)
		}
		upgradeProgress(fmt.Sprintf("⚠️ explicit DOWNGRADE %s → %s (allow_downgrade)", RunningVersion, target), 5)
	}

	// NEXUS-SELF-UPGRADE-003 — pin the origin BEFORE sending the bearer token:
	// a download_url to an arbitrary host would exfiltrate the token and make
	// each agent an SSRF pivot (internal endpoints / cloud metadata).
	if err := validateDownloadURL(downloadURL); err != nil {
		return nil, fmt.Errorf("download origin refused: %w", err)
	}

	newBinPath := "/var/lib/nexus-agent/nexus-agent.new"
	finalBinPath := "/usr/local/bin/nexus-agent"

	// Ensure the directory exists (StateDirectory should have created it)
	os.MkdirAll("/var/lib/nexus-agent", 0700)

	// 1. Download. Token in the Authorization header (not in the query: avoids
	// leaking the token into proxy/reverse-proxy access logs).
	upgradeProgress("Downloading the new binary…", 10)
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
	upgradeProgress(fmt.Sprintf("Downloaded: %d bytes", written), 45)

	// 2. SHA256 pre-check (transit corruption only, NOT authority).
	upgradeProgress("Verifying integrity (SHA256)…", 55)
	if expectedSHA256 != actualSHA256 {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("sha256 mismatch: expected %s, got %s", expectedSHA256, actualSHA256)
	}

	// 2b. VALIDATION AUTHORITY: detached minisign signature of the downloaded
	// binary, verified against the LOCAL accept-list, BEFORE any installation.
	// Channel-independent: even a fully compromised backend cannot
	// slip through a binary not signed by the operator's offline key.
	upgradeProgress("Verifying the release signature…", 65)
	staged, err := os.ReadFile(newBinPath) // verify→install window: TOCTOU handled by SELF-UPGRADE-004
	if err != nil {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("re-read of the staged binary: %w", err)
	}
	if !verifyAnyReleaseKey(releaseKeys, staged, []byte(signature)) {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("invalid release signature: update refused")
	}

	// chmod +x
	if err := os.Chmod(newBinPath, 0755); err != nil {
		return nil, fmt.Errorf("chmod: %w", err)
	}

	// SELF-UPGRADE-002 — bind the version assertion to the verified ARTIFACT, not just
	// to the param: read the binary's version (now SIGNED → safe to execute) and
	// require that it == the signed target. Prevents a backend from claiming one version
	// while serving another (signed) older binary.
	verOut, verErr := exec.Command(newBinPath, "--version").Output()
	gotVer := strings.TrimSpace(string(verOut))
	if verErr != nil || gotVer != strings.TrimSpace(target) {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("binary version (%q) ≠ signed target %q: update refused", gotVer, target)
	}

	// SELF-UPGRADE-004 (anti-TOCTOU, front) — re-hash the staged binary IMMEDIATELY
	// before install: if nexus-agent swapped it since the signature check, install
	// would not copy the verified bytes. Mismatch → refusal.
	recheck, rerr := os.ReadFile(newBinPath)
	if rerr != nil {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("pre-install re-read: %w", rerr)
	}
	rh := sha256.Sum256(recheck)
	if hex.EncodeToString(rh[:]) != actualSHA256 {
		os.Remove(newBinPath)
		return nil, fmt.Errorf("staged binary modified before install (TOCTOU): update refused")
	}

	// SELF-UPGRADE-005 — snapshot (backup) of the CURRENT binary to nexus-agent.prev
	// BEFORE overwriting it: we NEVER delete the only backup copy. The
	// dead-man's switch at boot will restore nexus-agent.prev if the new binary
	// does not confirm its reconnection.
	if err := snapshotPreviousBinary(); err != nil {
		return nil, fmt.Errorf("snapshot of the current binary (watchdog): %w", err)
	}

	// 3. Replace the current binary via sudo install (atomic)
	upgradeProgress("Installing the binary (atomic)…", 75)
	cmd := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", newBinPath, finalBinPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("install failed: %w: %s", err, string(output))
	}

	// SELF-UPGRADE-004 (anti-TOCTOU, back) — re-verify the INSTALLED binary before
	// restarting into it: we read /usr/local/bin/nexus-agent and require that its
	// SHA == the verified one. Otherwise we REFUSE the exit (no restart into a
	// tampered binary), even if the install "succeeded".
	installed, ierr := os.ReadFile(finalBinPath)
	if ierr != nil {
		return nil, fmt.Errorf("re-read of the installed binary: %w", ierr)
	}
	ih := sha256.Sum256(installed)
	installedSHA := hex.EncodeToString(ih[:])
	if installedSHA != actualSHA256 {
		return nil, fmt.Errorf("installed binary (%s) ≠ verified (%s): restart REFUSED (TOCTOU)", installedSHA, actualSHA256)
	}

	// SELF-UPGRADE-005 — mark the upgrade as pending (expected SHA): at boot,
	// RecoverPendingUpgrade will arm the dead-man's switch and restore .prev if the
	// new binary does not confirm its reconnection within the grace period
	// (ConfirmUpgrade cancels the revert). See agent_upgrade_watchdog.go.
	if err := markUpgradePending(actualSHA256); err != nil {
		log.Printf("[Upgrade] warning: watchdog marker not written (%v) — .prev remains the fallback", err)
	}

	// Clean up the temporary file (.new, NOT the .prev fallback)
	os.Remove(newBinPath)

	// 4. Launch a deferred exit (after returning the response)
	// systemd will restart the agent (Restart=always) with the new binary.
	upgradeProgress("Installed. Restarting the agent in 2s…", 90)
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
