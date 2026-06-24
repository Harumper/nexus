package actions

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

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
	installed := false
	bin := lynisPath()
	if bin == "" {
		// Tentative d'installation via apt (whitelist sudoers existante).
		// Si ça échoue (pas d'apt / pas de réseau), on remonte une erreur claire.
		_ = exec.Command("sudo", "-n", "/usr/bin/apt-get", "install", "-y", "-qq", "lynis").Run()
		bin = lynisPath()
		if bin == "" {
			return nil, fmt.Errorf("lynis introuvable et installation impossible (apt requis)")
		}
		installed = true
	}

	// Audit non-interactif (--cronjob = quiet + no-colors + non interactif).
	// Lynis écrit toujours son rapport dans /var/log/lynis-report.dat.
	cmd := exec.Command("sudo", "-n", bin, "audit", "system", "--cronjob")
	// Lynis sort un code != 0 si des warnings existent : ce n'est PAS une erreur
	// d'exécution. On ignore donc le code de sortie et on se fie au rapport.
	_ = cmd.Run()

	report, err := readLynisReport()
	if err != nil {
		return nil, fmt.Errorf("rapport Lynis illisible: %w", err)
	}

	parsed := parseLynisReport(report)
	parsed["lynis_installed_now"] = installed
	parsed["lynis_path"] = bin
	// État des remédiations « 1 clic » (pilote les boutons de l'UI).
	parsed["fail2ban_installed"] = fileExists("/usr/bin/fail2ban-client")
	parsed["fail2ban_active"] = systemctlActive("fail2ban")
	parsed["auto_updates_active"] = autoUpdatesActive()
	return parsed, nil
}

// Le rapport est root:root — lecture via sudo cat (chemin fixe whitelisté).
func readLynisReport() ([]byte, error) {
	if data, err := os.ReadFile(lynisReportPath); err == nil {
		return data, nil
	}
	return exec.Command("sudo", "-n", "/bin/cat", lynisReportPath).Output()
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
