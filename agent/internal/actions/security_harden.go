package actions

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

func init() {
	Register(&HardenFail2banAction{})
	Register(&EnableAutoUpdatesAction{})
	Register(&SetLoginBannerAction{})
	Register(&DisableCoreDumpsAction{})
	Register(&HardenLoginDefsAction{})
}

// ── core dumps (KRNL-5820) ──
const nocoreLimitsPath = "/etc/security/limits.d/99-nexus-nocore.conf"
const coredumpSysctlPath = "/etc/sysctl.d/99-nexus-coredump.conf"
const nocoreConf = `# Généré par Nexus — désactivation des core dumps (KRNL-5820).
* hard core 0
* soft core 0
root hard core 0
`
const coredumpSysctl = `# Généré par Nexus — pas de core dump pour binaires setuid (KRNL-5820).
fs.suid_dumpable = 0
`

// ── login.defs (AUTH-9230/9286/9328) ──
const loginDefsPath = "/etc/login.defs"

var loginDefsSettings = [][2]string{
	{"UMASK", "027"},
	{"PASS_MAX_DAYS", "90"},
	{"PASS_MIN_DAYS", "1"},
	{"PASS_WARN_AGE", "14"},
	{"SHA_CRYPT_MIN_ROUNDS", "640000"},
}

// Bannière légale par défaut (BANN-7126/7130) — surchargeable via le param "text".
const loginBanner = `*** Acces restreint - Nexus ***
Tout acces non autorise a ce systeme est interdit et peut faire l'objet de
poursuites. Toutes les activites peuvent etre journalisees et surveillees.
`

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

// ──────────────────── bannière légale ────────────────────

type SetLoginBannerAction struct{}

func (a *SetLoginBannerAction) ID() string         { return "security.set_login_banner" }
func (a *SetLoginBannerAction) Capability() string { return "security" }

func (a *SetLoginBannerAction) Validate(params map[string]interface{}) error {
	if t, ok := params["text"].(string); ok {
		if len(t) > 4096 {
			return fmt.Errorf("bannière trop longue (max 4096 caractères)")
		}
		if strings.ContainsRune(t, '\x00') {
			return fmt.Errorf("bannière invalide (caractère nul)")
		}
	}
	return nil
}

func (a *SetLoginBannerAction) Execute(params map[string]interface{}) (interface{}, error) {
	// Texte configurable (param "text") ; défaut Nexus si vide/absent.
	banner := loginBanner
	if t, ok := params["text"].(string); ok && strings.TrimSpace(t) != "" {
		banner = strings.TrimRight(t, "\n") + "\n"
	}
	// /etc/issue (console locale) ET /etc/issue.net (connexions réseau/SSH).
	if err := installRootFile(banner, "sec-banner-*.tmp", "/etc/issue"); err != nil {
		return nil, err
	}
	if err := installRootFile(banner, "sec-banner-*.tmp", "/etc/issue.net"); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"login_banner_set": true,
		"files":            []string{"/etc/issue", "/etc/issue.net"},
	}, nil
}

// loginBannerSet : un vrai bandeau est en place si /etc/issue contient du texte
// substantiel (au-delà du défaut distrib type "Ubuntu 24.04 LTS \n \l").
// Heuristique indépendante du contenu (le texte est configurable) : on retire
// les échappements \X et les espaces, et on exige ≥ 40 caractères utiles.
func loginBannerSet() bool {
	data, err := os.ReadFile("/etc/issue")
	if err != nil {
		return false
	}
	stripped := regexp.MustCompile(`\\.`).ReplaceAllString(string(data), "")
	return len(strings.TrimSpace(stripped)) >= 40
}

// ──────────────────── core dumps ────────────────────

type DisableCoreDumpsAction struct{}

func (a *DisableCoreDumpsAction) ID() string                              { return "security.disable_core_dumps" }
func (a *DisableCoreDumpsAction) Capability() string                      { return "security" }
func (a *DisableCoreDumpsAction) Validate(_ map[string]interface{}) error { return nil }

func (a *DisableCoreDumpsAction) Execute(_ map[string]interface{}) (interface{}, error) {
	if err := installRootFile(nocoreConf, "sec-nocore-*.tmp", nocoreLimitsPath); err != nil {
		return nil, err
	}
	if err := installRootFile(coredumpSysctl, "sec-coredump-*.tmp", coredumpSysctlPath); err != nil {
		return nil, err
	}
	// Appliquer immédiatement le sysctl (le limits.d s'applique aux nouvelles sessions).
	if err := sudoRun("/usr/sbin/sysctl", "-p", coredumpSysctlPath); err != nil {
		return nil, fmt.Errorf("sysctl -p: %w", err)
	}
	return map[string]interface{}{
		"core_dumps_disabled": true,
		"files":               []string{nocoreLimitsPath, coredumpSysctlPath},
	}, nil
}

func coreDumpsDisabled() bool {
	return fileExists(nocoreLimitsPath) && fileExists(coredumpSysctlPath)
}

// ──────────────────── login.defs ────────────────────

type HardenLoginDefsAction struct{}

func (a *HardenLoginDefsAction) ID() string                              { return "security.harden_login_defs" }
func (a *HardenLoginDefsAction) Capability() string                      { return "security" }
func (a *HardenLoginDefsAction) Validate(_ map[string]interface{}) error { return nil }

func (a *HardenLoginDefsAction) Execute(_ map[string]interface{}) (interface{}, error) {
	data, err := os.ReadFile(loginDefsPath) // world-readable
	if err != nil {
		return nil, fmt.Errorf("lecture %s: %w", loginDefsPath, err)
	}
	content := string(data)
	for _, kv := range loginDefsSettings {
		content = setLoginDef(content, kv[0], kv[1])
	}
	if err := installRootFile(content, "sec-logindefs-*.tmp", loginDefsPath); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"login_defs_hardened": true,
		"applied":             loginDefsSettings,
	}, nil
}

// setLoginDef remplace (ou ajoute) une directive KEY dans le contenu login.defs.
// Idempotent : conserve la 1ʳᵉ occurrence (active ou commentée) réécrite à la
// bonne valeur, supprime les doublons éventuels.
func setLoginDef(content, key, value string) string {
	re := regexp.MustCompile(`^[\t ]*#?[\t ]*` + regexp.QuoteMeta(key) + `([\t ]|=|$)`)
	lines := strings.Split(content, "\n")
	out := make([]string, 0, len(lines)+1)
	done := false
	for _, l := range lines {
		if re.MatchString(l) {
			if !done {
				out = append(out, key+"\t"+value)
				done = true
			}
			continue // supprime les doublons
		}
		out = append(out, l)
	}
	if !done {
		out = append(out, key+"\t"+value)
	}
	return strings.Join(out, "\n")
}

func loginDefsHardened() bool {
	data, err := os.ReadFile(loginDefsPath)
	if err != nil {
		return false
	}
	return regexp.MustCompile(`(?m)^[\t ]*UMASK[\t ]+027\b`).Match(data)
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
