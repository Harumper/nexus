package actions

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func init() {
	Register(&HardenFail2banAction{})
	Register(&EnableAutoUpdatesAction{})
}

// ═══════════════════════════════════════════════════════════════
// Remédiations de durcissement « installer un utilitaire » (Phase 2).
// Mutations -> réservées aux machines AGENT (PAS dans la whitelist PROBE).
// Passent par dispatchAction (RBAC + confirmation côté UI).
// ═══════════════════════════════════════════════════════════════

const autoUpdatesConfPath = "/etc/apt/apt.conf.d/20auto-upgrades"

// jail.local curé : protège SSH par défaut, lit le journal systemd.
const fail2banJailLocal = `# Généré par Nexus — protection anti-bruteforce de base.
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
`

const autoUpdatesConf = `// Généré par Nexus — mises à jour de sécurité automatiques.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`

// ───────────────────────── fail2ban ─────────────────────────

type HardenFail2banAction struct{}

func (a *HardenFail2banAction) ID() string                          { return "security.harden_fail2ban" }
func (a *HardenFail2banAction) Capability() string                  { return "security" }
func (a *HardenFail2banAction) Validate(_ map[string]interface{}) error { return nil }

func (a *HardenFail2banAction) Execute(_ map[string]interface{}) (interface{}, error) {
	// 1. Installer si absent (apt whitelisté)
	if !fileExists("/usr/bin/fail2ban-client") {
		if err := sudoRun("/usr/bin/apt-get", "install", "-y", "-qq", "fail2ban"); err != nil {
			return nil, fmt.Errorf("installation fail2ban: %w", err)
		}
	}

	// 2. Déposer jail.local (tempfile + sudo install, comme netplan/sshkeys)
	if err := installRootFile(fail2banJailLocal, "sec-fail2ban-*.tmp", "/etc/fail2ban/jail.local"); err != nil {
		return nil, err
	}

	// 3. Activer + (re)démarrer
	if err := sudoRun("/usr/bin/systemctl", "enable", "fail2ban"); err != nil {
		return nil, fmt.Errorf("enable fail2ban: %w", err)
	}
	if err := sudoRun("/usr/bin/systemctl", "restart", "fail2ban"); err != nil {
		return nil, fmt.Errorf("restart fail2ban: %w", err)
	}

	return map[string]interface{}{
		"fail2ban_installed": true,
		"fail2ban_active":    systemctlActive("fail2ban"),
		"jail":               "/etc/fail2ban/jail.local",
	}, nil
}

// ──────────────────── unattended-upgrades ────────────────────

type EnableAutoUpdatesAction struct{}

func (a *EnableAutoUpdatesAction) ID() string                          { return "security.enable_auto_updates" }
func (a *EnableAutoUpdatesAction) Capability() string                  { return "security" }
func (a *EnableAutoUpdatesAction) Validate(_ map[string]interface{}) error { return nil }

func (a *EnableAutoUpdatesAction) Execute(_ map[string]interface{}) (interface{}, error) {
	if !fileExists("/usr/bin/unattended-upgrade") && !fileExists("/usr/bin/unattended-upgrades") {
		if err := sudoRun("/usr/bin/apt-get", "install", "-y", "-qq", "unattended-upgrades"); err != nil {
			return nil, fmt.Errorf("installation unattended-upgrades: %w", err)
		}
	}

	if err := installRootFile(autoUpdatesConf, "sec-autoupd-*.tmp", autoUpdatesConfPath); err != nil {
		return nil, err
	}

	// Le service applique les MAJ via les timers apt-daily ; on l'active aussi.
	_ = sudoRun("/usr/bin/systemctl", "enable", "unattended-upgrades")

	return map[string]interface{}{
		"auto_updates_active": autoUpdatesActive(),
		"config":              autoUpdatesConfPath,
	}, nil
}

// ───────────────────────── helpers ─────────────────────────

// installRootFile écrit le contenu dans un tempfile (/var/lib/nexus-agent) puis
// le déplace en root via `sudo install` (chemin de destination fixe whitelisté).
func installRootFile(content, tmpPattern, dest string) error {
	tmp, err := os.CreateTemp("/var/lib/nexus-agent", tmpPattern)
	if err != nil {
		return fmt.Errorf("tempfile: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return fmt.Errorf("write tempfile: %w", err)
	}
	tmp.Close()
	if err := sudoRun("/usr/bin/install", "-m", "644", "-o", "root", "-g", "root", tmp.Name(), dest); err != nil {
		return fmt.Errorf("install %s: %w", dest, err)
	}
	return nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// systemctlActive renvoie true si l'unité est active (is-active, sans root).
func systemctlActive(unit string) bool {
	out, _ := exec.Command("systemctl", "is-active", unit).Output()
	return strings.TrimSpace(string(out)) == "active"
}

// autoUpdatesActive : le fichier de conf existe et active Unattended-Upgrade.
func autoUpdatesActive() bool {
	data, err := os.ReadFile(autoUpdatesConfPath)
	if err != nil {
		return false
	}
	return strings.Contains(string(data), `Unattended-Upgrade "1"`)
}
