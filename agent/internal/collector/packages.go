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

func listPendingApt() ([]PendingUpdate, error) {
	// Étape 1 : mise à jour de l'index (apt-get update)
	// Chemin ABSOLU, arguments HARDCODÉS
	updateCmd := exec.Command("/usr/bin/apt-get", "update", "-qq")
	updateCmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	if err := updateCmd.Run(); err != nil {
		return nil, fmt.Errorf("apt-get update failed: %w", err)
	}

	// Étape 2 : lister les upgradables
	// Chemin ABSOLU, arguments HARDCODÉS
	cmd := exec.Command("/usr/bin/apt", "list", "--upgradable")
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("apt list failed: %w", err)
	}

	var updates []PendingUpdate
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "Listing...") || line == "" {
			continue
		}

		// Format: package/source version arch [upgradable from: old_version]
		parts := strings.Fields(line)
		if len(parts) < 2 {
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

		updates = append(updates, PendingUpdate{
			Name:           name,
			CurrentVersion: currentVersion,
			NewVersion:     newVersion,
			SecurityUpdate: isSecurity,
		})
	}

	return updates, nil
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
