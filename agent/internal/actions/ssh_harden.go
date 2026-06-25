package actions

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func init() {
	Register(&SshHardenAction{})
}

// ═══════════════════════════════════════════════════════════════
// sshd.harden : applique un drop-in sshd_config durci, avec le pattern
// watchdog-revert IDENTIQUE à firewall/netplan (snapshot -> mutation ->
// AfterFunc revert -> confirm WS -> dead-man's switch au boot).
//
// Anti-lock-out (impératif) :
//   1. `sshd -t` valide la config AVANT tout rechargement (abandon si KO).
//   2. Rechargement par SIGHUP au master sshd (PAS `systemctl reload ssh`,
//      bloqué en sudoers) : ne coupe PAS les sessions existantes.
//   3. Watchdog 120s : si non confirmé, le drop-in précédent est restauré.
// Le drop-in NE touche PAS PasswordAuthentication/PermitRootLogin (évite le
// verrouillage involontaire) — seulement algos modernes + limites.
// ═══════════════════════════════════════════════════════════════

const (
	sshdWatchdogDuration = 120 * time.Second
	sshdDropinPath       = "/etc/ssh/sshd_config.d/99-nexus-hardening.conf"
	sshdDropinName       = "99-nexus-hardening.conf"
	sshdSnapshotPrefix   = "sshd-snapshot-"
)

const sshdHardeningDropin = `# Généré par Nexus — durcissement SSH (algos modernes + limites raisonnables).
# Volontairement NON modifiés ici : PasswordAuthentication et PermitRootLogin,
# pour éviter tout verrouillage involontaire (à durcir séparément, en connaissance de cause).
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512,diffie-hellman-group-exchange-sha256
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com
MaxAuthTries 4
LoginGraceTime 30
X11Forwarding no
`

type PendingSshd struct {
	RequestID   string
	SnapshotDir string
	Timer       *time.Timer
	CreatedAt   time.Time
}

var (
	sshdMu      sync.Mutex
	pendingSshd = map[string]*PendingSshd{}
)

// HandleSshdConfirm annule le revert pending (confirmation reçue).
func HandleSshdConfirm(requestID string) {
	sshdMu.Lock()
	defer sshdMu.Unlock()
	p, ok := pendingSshd[requestID]
	if !ok {
		return
	}
	p.Timer.Stop()
	os.RemoveAll(p.SnapshotDir)
	delete(pendingSshd, requestID)
	log.Printf("[SSHd] Hardening confirmed for request_id=%s, snapshot discarded", requestID)
}

// RecoverPendingSshd est appelé au démarrage de l'agent (dead-man's switch).
func RecoverPendingSshd() {
	entries, err := os.ReadDir(snapshotDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), sshdSnapshotPrefix) {
			continue
		}
		snapDir := filepath.Join(snapshotDir, e.Name())
		log.Printf("[SSHd] Recovering pending snapshot %s — reverting", snapDir)
		if err := restoreSshdFromSnapshot(snapDir); err != nil {
			log.Printf("[SSHd] Revert failed: %v", err)
		}
		os.RemoveAll(snapDir)
	}
}

// snapshotSshd copie le drop-in courant (s'il existe) dans un tempdir dédié.
// Si le drop-in n'existe pas, le snapshot reste vide -> la restauration le
// supprimera (retour à l'état "absent").
func snapshotSshd(requestID string) (string, error) {
	os.MkdirAll(snapshotDir, 0700)
	snapDir := filepath.Join(snapshotDir, sshdSnapshotPrefix+requestID)
	if err := os.MkdirAll(snapDir, 0700); err != nil {
		return "", err
	}
	if _, err := os.Stat(sshdDropinPath); err == nil {
		// sudo cat car le fichier peut être root:root
		out, err := exec.Command("sudo", "-n", "/bin/cat", sshdDropinPath).Output()
		if err != nil {
			return "", fmt.Errorf("snapshot read: %w", err)
		}
		if err := os.WriteFile(filepath.Join(snapDir, sshdDropinName), out, 0600); err != nil {
			return "", err
		}
	}
	return snapDir, nil
}

// restoreSshdFromSnapshot remet l'état d'avant : réinstalle le drop-in du
// snapshot s'il existait, sinon supprime le drop-in. Puis recharge sshd.
func restoreSshdFromSnapshot(snapDir string) error {
	snapFile := filepath.Join(snapDir, sshdDropinName)
	if _, err := os.Stat(snapFile); err == nil {
		if err := sudoRun("/usr/bin/install", "-m", "644", "-o", "root", "-g", "root", snapFile, sshdDropinPath); err != nil {
			return fmt.Errorf("restore install: %w", err)
		}
	} else {
		// Le drop-in n'existait pas avant -> le retirer.
		if err := sudoRun("/bin/rm", "-f", sshdDropinPath); err != nil {
			return fmt.Errorf("restore rm: %w", err)
		}
	}
	return reloadSshd()
}

// registerPendingSshd snapshot + arme le timer 120s.
func registerPendingSshd(requestID string) (*PendingSshd, error) {
	sshdMu.Lock()
	if len(pendingSshd) > 0 {
		sshdMu.Unlock()
		return nil, fmt.Errorf("another SSH hardening change is pending confirmation")
	}
	sshdMu.Unlock()

	snapDir, err := snapshotSshd(requestID)
	if err != nil {
		return nil, err
	}

	p := &PendingSshd{RequestID: requestID, SnapshotDir: snapDir, CreatedAt: time.Now()}
	p.Timer = time.AfterFunc(sshdWatchdogDuration, func() {
		sshdMu.Lock()
		defer sshdMu.Unlock()
		if _, still := pendingSshd[requestID]; !still {
			return
		}
		log.Printf("[SSHd] Watchdog expired for request_id=%s — reverting", requestID)
		if err := restoreSshdFromSnapshot(p.SnapshotDir); err != nil {
			log.Printf("[SSHd] Revert failed: %v", err)
		}
		os.RemoveAll(p.SnapshotDir)
		delete(pendingSshd, requestID)
	})

	sshdMu.Lock()
	pendingSshd[requestID] = p
	sshdMu.Unlock()
	return p, nil
}

// reloadSshd recharge la config sshd via SIGHUP au master (pas de coupure des
// sessions en cours). `systemctl reload ssh` est volontairement bloqué en sudoers.
func reloadSshd() error {
	pid := sshdMasterPID()
	if pid == "" {
		return fmt.Errorf("sshd master PID introuvable")
	}
	return sudoRun("/bin/kill", "-SIGHUP", pid)
}

func sshdMasterPID() string {
	if b, err := os.ReadFile("/run/sshd.pid"); err == nil {
		if p := strings.TrimSpace(string(b)); isNumeric(p) {
			return p
		}
	}
	out, err := exec.Command("pidof", "sshd").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return ""
	}
	// pidof liste du plus récent au plus ancien ; le master est le plus ancien.
	last := fields[len(fields)-1]
	if !isNumeric(last) {
		return ""
	}
	return last
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

type SshHardenAction struct{}

func (a *SshHardenAction) ID() string                          { return "sshd.harden" }
func (a *SshHardenAction) Capability() string                  { return "security" }
func (a *SshHardenAction) Validate(_ map[string]interface{}) error { return nil }

func (a *SshHardenAction) Execute(params map[string]interface{}) (interface{}, error) {
	// Aperçu (dry-run) : renvoie EXACTEMENT ce qui serait écrit, sans rien
	// appliquer (pas de snapshot/install/reload/watchdog). Permet à l'UI de
	// montrer le contenu avant que l'utilisateur ne confirme — source unique
	// = l'agent (aucun risque de divergence avec un texte recopié côté UI).
	if dr, _ := params["dry_run"].(bool); dr {
		return map[string]interface{}{
			"dry_run":             true,
			"dropin":              sshdDropinPath,
			"content":             sshdHardeningDropin,
			"watchdog_expires_in": int(sshdWatchdogDuration.Seconds()),
		}, nil
	}

	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("sshd-%d", time.Now().UnixNano())
	}

	// 1. Snapshot + arme le watchdog
	pr, err := registerPendingSshd(reqID)
	if err != nil {
		return nil, err
	}

	// 2. Écrire le drop-in durci (tempfile + sudo install)
	tmp, err := os.CreateTemp(snapshotDir, "sshd-dropin-*.tmp")
	if err != nil {
		HandleSshdConfirm(reqID)
		return nil, fmt.Errorf("create temp: %w", err)
	}
	tmp.WriteString(sshdHardeningDropin)
	tmp.Close()
	defer os.Remove(tmp.Name())

	if err := sudoRun("/usr/bin/install", "-m", "644", "-o", "root", "-g", "root", tmp.Name(), sshdDropinPath); err != nil {
		HandleSshdConfirm(reqID)
		return nil, fmt.Errorf("install drop-in: %w", err)
	}

	// 3. VALIDER avant tout rechargement (anti-lock-out #1)
	if err := sudoRun("/usr/sbin/sshd", "-t"); err != nil {
		// Config invalide -> on revient à l'état précédent puis on annule.
		_ = restoreSshdFromSnapshot(pr.SnapshotDir)
		HandleSshdConfirm(reqID)
		return nil, fmt.Errorf("sshd -t validation échouée, drop-in annulé: %w", err)
	}

	// 4. Recharger (SIGHUP master) — sessions existantes préservées
	if err := reloadSshd(); err != nil {
		_ = restoreSshdFromSnapshot(pr.SnapshotDir)
		HandleSshdConfirm(reqID)
		return nil, fmt.Errorf("reload sshd échoué: %w", err)
	}

	return map[string]interface{}{
		"applied":             true,
		"request_id":          reqID,
		"dropin":              sshdDropinPath,
		"watchdog_expires_in": int(sshdWatchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(sshdWatchdogDuration).Format(time.RFC3339),
	}, nil
}
