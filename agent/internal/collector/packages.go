package collector

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type PackageManager string

const (
	PMUnknown PackageManager = "unknown"
	PMApt     PackageManager = "apt"
	PMYum     PackageManager = "yum"
	PMDnf     PackageManager = "dnf"
)

type PendingUpdate struct {
	Name           string `json:"name"`
	CurrentVersion string `json:"current_version"`
	NewVersion     string `json:"new_version"`
	SecurityUpdate bool   `json:"security_update"`
	// Deferred = paquet listé comme upgradable mais qu'`apt-get upgrade`
	// n'installera PAS immédiatement (phased update / kept-back).
	// C'est ce qui explique l'écart avec "X mises à jour peuvent être
	// appliquées immédiatement" du MOTD (apt-check).
	Deferred bool `json:"deferred"`
}

type UpdateResult struct {
	Success       bool   `json:"success"`
	PackageCount  int    `json:"package_count"`
	Output        string `json:"output"`
	ErrorOutput   string `json:"error_output,omitempty"`
}

// DetectPackageManager détecte le gestionnaire de paquets installé
// Vérifie l'existence des binaires à des chemins absolus
func DetectPackageManager() PackageManager {
	paths := []struct {
		path string
		pm   PackageManager
	}{
		{"/usr/bin/apt-get", PMApt},
		{"/usr/bin/dnf", PMDnf},
		{"/usr/bin/yum", PMYum},
	}

	for _, p := range paths {
		if _, err := os.Stat(p.path); err == nil {
			return p.pm
		}
	}

	return PMUnknown
}

// ListPendingUpdates liste les mises à jour disponibles
// Chaque package manager a sa commande HARDCODÉE
func ListPendingUpdates(pm PackageManager) ([]PendingUpdate, error) {
	switch pm {
	case PMApt:
		return listPendingApt()
	case PMDnf:
		return listPendingDnf()
	case PMYum:
		return listPendingYum()
	default:
		return nil, fmt.Errorf("unsupported package manager: %s", pm)
	}
}

// ===================== APT =====================

// aptEnv force la locale C : sans ça apt répond dans la langue système
// (ex. en-tête français "En train de lister…" au lieu de "Listing..."),
// ce qui cassait le parsing — un faux paquet "En"/"train" apparaissait et
// la colonne "Actuelle" était vide (le code cherche le token "from:").
func aptEnv() []string {
	return append(os.Environ(),
		"DEBIAN_FRONTEND=noninteractive",
		"LC_ALL=C",
		"LANG=C",
	)
}

func listPendingApt() ([]PendingUpdate, error) {
	// Étape 1 : mise à jour de l'index (apt-get update)
	// Via sudo — l'agent tourne sous nexus-agent (non-root)
	updateCmd := exec.Command("/usr/bin/sudo", "/usr/bin/apt-get", "update")
	updateCmd.Env = aptEnv()
	if out, err := updateCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("apt-get update failed: %w: %s", err, string(out))
	}

	// Étape 2 : lister les upgradables (pas besoin de sudo)
	cmd := exec.Command("/usr/bin/apt", "list", "--upgradable")
	cmd.Env = aptEnv()
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("apt list failed: %w", err)
	}

	// Ensemble des paquets qu'`apt-get upgrade` installerait réellement,
	// pour distinguer les phased/kept-back (différés) du reste.
	installable := aptInstallableSet()

	var updates []PendingUpdate
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.Contains(line, "Listing...") {
			continue
		}

		// Format attendu : package/source version arch [upgradable from: old_version]
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		// Garde-fou indépendant de la locale : une vraie ligne upgradable
		// commence toujours par "nom/suite". Les en-têtes/notes traduits
		// (ex. "En train de lister…") n'ont pas de "/" → on les ignore.
		if !strings.Contains(parts[0], "/") {
			continue
		}

		nameParts := strings.SplitN(parts[0], "/", 2)
		name := nameParts[0]
		newVersion := parts[1]

		var currentVersion string
		for i, p := range parts {
			if p == "from:" && i+1 < len(parts) {
				currentVersion = strings.TrimSuffix(parts[i+1], "]")
				break
			}
		}

		isSecurity := false
		if len(nameParts) > 1 {
			isSecurity = strings.Contains(nameParts[1], "security")
		}

		// Différé si présent dans la liste upgradable mais absent du set
		// que `apt-get upgrade` installerait (installable == nil => on a
		// échoué à simuler, on ne marque rien plutôt que de mentir).
		deferred := false
		if installable != nil {
			_, ok := installable[name]
			deferred = !ok
		}

		updates = append(updates, PendingUpdate{
			Name:           name,
			CurrentVersion: currentVersion,
			NewVersion:     newVersion,
			SecurityUpdate: isSecurity,
			Deferred:       deferred,
		})
	}

	return updates, nil
}

// aptInstallableSet simule `apt-get upgrade` et renvoie l'ensemble des
// paquets qui seraient effectivement mis à jour (lignes "Inst ..."). Les
// phased updates et kept-back en sont absents — c'est exactement ce que
// compte "X mises à jour peuvent être appliquées immédiatement".
// Renvoie nil en cas d'échec (on ne marque alors aucun paquet comme différé).
func aptInstallableSet() map[string]bool {
	cmd := exec.Command("/usr/bin/apt-get", "-s", "upgrade")
	cmd.Env = aptEnv()
	output, err := cmd.Output()
	if err != nil {
		return nil
	}

	set := make(map[string]bool)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		// Format: "Inst <name> [old] (new suite [arch])"
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "Inst" {
			set[fields[1]] = true
		}
	}
	return set
}

// ===================== DNF =====================

func listPendingDnf() ([]PendingUpdate, error) {
	// Chemin ABSOLU, arguments HARDCODÉS
	cmd := exec.Command("/usr/bin/dnf", "check-update", "-q")
	output, _ := cmd.Output() // dnf check-update retourne exit code 100 si des updates existent

	var updates []PendingUpdate
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) >= 2 {
			updates = append(updates, PendingUpdate{
				Name:       parts[0],
				NewVersion: parts[1],
			})
		}
	}

	return updates, nil
}

// ===================== YUM =====================

func listPendingYum() ([]PendingUpdate, error) {
	// Chemin ABSOLU, arguments HARDCODÉS
	cmd := exec.Command("/usr/bin/yum", "check-update", "-q")
	output, _ := cmd.Output()

	var updates []PendingUpdate
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) >= 2 {
			updates = append(updates, PendingUpdate{
				Name:       parts[0],
				NewVersion: parts[1],
			})
		}
	}

	return updates, nil
}
