package actions

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// OnSecurityProgress streame les lignes de l'audit Lynis vers le frontend
// (console live), comme OnUpdateProgress pour apt. Câblé dans main.go.
var OnSecurityProgress ProgressCallback

func init() {
	Register(&SecurityAuditAction{})
}

// ═══════════════════════════════════════════════════════════════
// security.audit : lance Lynis (audit de durcissement, FOSS GPLv3) et
// renvoie un résultat structuré (hardening index, warnings, suggestions,
// état parefeu). LECTURE SEULE — Lynis n'applique aucune modification.
// Le mapping finding -> remédiation se fait côté backend/UI (1 clic).
// ═══════════════════════════════════════════════════════════════

type SecurityAuditAction struct{}

func (a *SecurityAuditAction) ID() string              { return "security.audit" }
func (a *SecurityAuditAction) Capability() string      { return "monitoring" }
func (a *SecurityAuditAction) Validate(_ map[string]interface{}) error { return nil }

const lynisReportPath = "/var/log/lynis-report.dat"

// Chemins possibles du binaire lynis selon le packaging (Debian/Ubuntu =
// /usr/sbin, EPEL/autres = /usr/bin). Les DEUX sont whitelistés en sudoers.
var lynisPaths = []string{"/usr/sbin/lynis", "/usr/bin/lynis"}

func lynisPath() string {
	for _, p := range lynisPaths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

type lynisItem struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func (a *SecurityAuditAction) Execute(_ map[string]interface{}) (interface{}, error) {
	if OnSecurityProgress != nil {
		OnSecurityProgress("Lancement de l'audit Lynis…", 2)
	}
	// NEXUS-AGENT-007 — un audit OBSERVE, il ne MUTE jamais la machine auditée.
	// security.audit n'installe plus Lynis : c'est un défaut de conception qu'un
	// audit altère son sujet. Si Lynis est absent, on dégrade proprement avec un
	// message actionnable — son installation relève du provisioning opérateur
	// (apt/dnf install lynis), hors du périmètre agent.
	installed := false // cette action n'installe jamais rien
	bin := lynisPath()
	if bin == "" {
		return nil, fmt.Errorf("lynis non installé : audit indisponible. Provisionnez-le (apt install lynis / dnf install lynis) pour activer l'audit de sécurité — l'agent n'installe pas de paquet lors d'un audit (lecture seule)")
	}

	// Audit en STREAMING : on lit la sortie de lynis ligne par ligne et on la
	// pousse via OnSecurityProgress (console live côté UI). --quick évite la
	// pause de fin ; --no-colors pour une sortie propre. Lynis écrit toujours
	// son rapport dans /var/log/lynis-report.dat.
	// Timeout dur (5 min) : un lynis qui se bloque ne doit jamais figer l'agent
	// ni le modal indéfiniment. Setpgid + Cancel tuent tout le groupe à l'expiration.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sudo", "-n", bin, "audit", "system", "--quick", "--no-colors")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	stdout, pipeErr := cmd.StdoutPipe()
	if pipeErr != nil {
		return nil, fmt.Errorf("pipe lynis: %w", pipeErr)
	}
	cmd.Stderr = cmd.Stdout // combiner stderr (ex. refus sudo) dans le flux
	auditStart := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("lancement de lynis échoué: %w", err)
	}
	lineCount := 0
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		lineCount++
		if OnSecurityProgress != nil {
			OnSecurityProgress(sc.Text(), min(5+lineCount/4, 95))
		}
	}
	// Code de sortie != 0 = warnings présents : NON bloquant. On se fie au rapport.
	_ = cmd.Wait()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("audit Lynis interrompu : timeout (5 min) dépassé")
	}

	// Garde-fou : si le rapport n'a pas été RÉ-écrit par cette exécution (mtime
	// antérieur au lancement), c'est que lynis n'a pas pu tourner (typiquement
	// "sudo: a password is required" → sudoers obsolètes). On refuse de renvoyer
	// l'ancien rapport comme s'il était frais.
	if fi, statErr := os.Stat(lynisReportPath); statErr != nil || fi.ModTime().Before(auditStart) {
		return nil, fmt.Errorf("Lynis n'a pas pu s'exécuter (droits sudo insuffisants ? sudoers obsolètes — ré-installer/ré-enrôler l'agent). Aucun rapport frais produit.")
	}

	report, err := readLynisReport()
	if err != nil {
		// Les lignes (dont un éventuel refus sudo) ont déjà été streamées.
		return nil, fmt.Errorf("rapport Lynis indisponible: %v", err)
	}
	if OnSecurityProgress != nil {
		OnSecurityProgress("Audit terminé.", 100)
	}

	parsed := parseLynisReport(report)
	parsed["lynis_installed_now"] = installed
	parsed["lynis_path"] = bin
	// État des remédiations « 1 clic » (pilote les boutons de l'UI).
	parsed["fail2ban_installed"] = fileExists("/usr/bin/fail2ban-client")
	parsed["fail2ban_active"] = systemctlActive("fail2ban")
	parsed["auto_updates_active"] = autoUpdatesActive()
	parsed["ssh_hardened"] = fileExists(sshdDropinPath)
	parsed["login_banner_set"] = loginBannerSet()
	parsed["core_dumps_disabled"] = coreDumpsDisabled()
	parsed["login_defs_hardened"] = loginDefsHardened()
	return parsed, nil
}

// Le rapport est root:root — lecture via sudo cat (chemin fixe whitelisté).
func readLynisReport() ([]byte, error) {
	if data, err := os.ReadFile(lynisReportPath); err == nil {
		return data, nil
	}
	out, err := exec.Command("sudo", "-n", "/bin/cat", lynisReportPath).CombinedOutput()
	if err != nil {
		// Remonte la vraie cause : "No such file" (lynis n'a pas tourné) vs
		// "a password is required"/"not allowed" (sudoers cat manquant).
		return nil, fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return out, nil
}

// parseLynisReport parse le format plat key=value de lynis-report.dat.
// Champs notables : hardening_index, warning[]=ID|texte|..., suggestion[]=...,
// firewall_active, firewall_empty_ruleset, lynis_version.
func parseLynisReport(data []byte) map[string]interface{} {
	warnings := []lynisItem{}
	suggestions := []lynisItem{}
	scalars := map[string]string{}

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		key := line[:eq]
		val := line[eq+1:]

		switch key {
		case "warning[]":
			warnings = append(warnings, splitLynisItem(val))
		case "suggestion[]":
			suggestions = append(suggestions, splitLynisItem(val))
		default:
			// On ne garde que la dernière valeur des clés scalaires.
			if !strings.HasSuffix(key, "[]") {
				scalars[key] = val
			}
		}
	}

	hardeningIndex := -1
	if v, ok := scalars["hardening_index"]; ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			hardeningIndex = n
		}
	}

	return map[string]interface{}{
		"hardening_index":        hardeningIndex,
		"lynis_version":          scalars["lynis_version"],
		"warnings":               warnings,
		"suggestions":            suggestions,
		"warning_count":          len(warnings),
		"suggestion_count":       len(suggestions),
		"firewall_active":        scalars["firewall_active"] == "1",
		"firewall_empty_ruleset": scalars["firewall_empty_ruleset"] == "1",
		"scan_date":              scalars["report_datetime_start"],
	}
}

// Un item Lynis = "TEST-ID|description|details|solution" (champs séparés par |,
// souvent "-" quand vide). On retient l'ID et le premier champ texte non vide.
func splitLynisItem(val string) lynisItem {
	parts := strings.Split(val, "|")
	item := lynisItem{}
	if len(parts) > 0 {
		item.ID = strings.TrimSpace(parts[0])
	}
	for _, p := range parts[1:] {
		p = strings.TrimSpace(p)
		if p != "" && p != "-" {
			item.Text = p
			break
		}
	}
	return item
}
