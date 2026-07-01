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
	// Deferred = package listed as upgradable but that `apt-get upgrade`
	// will NOT install immediately (phased update / kept-back).
	// This explains the gap with "X updates can be applied immediately"
	// from the MOTD (apt-check).
	Deferred bool `json:"deferred"`
}

type UpdateResult struct {
	Success      bool   `json:"success"`
	PackageCount int    `json:"package_count"`
	Output       string `json:"output"`
	ErrorOutput  string `json:"error_output,omitempty"`
}

// DetectPackageManager detects the installed package manager
// Checks for the existence of the binaries at absolute paths
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

// ListPendingUpdates lists the available updates
// Each package manager has its own HARDCODED command
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

// aptEnv forces the C locale: without it apt responds in the system language
// (e.g. French header "En train de lister…" instead of "Listing..."), which
// broke the parsing — a fake package "En"/"train" appeared and the "current"
// column was empty (the code looks for the "from:" token).
func aptEnv() []string {
	return append(os.Environ(),
		"DEBIAN_FRONTEND=noninteractive",
		"LC_ALL=C",
		"LANG=C",
	)
}

func listPendingApt() ([]PendingUpdate, error) {
	// Step 1: update the index (apt-get update)
	// Via sudo — the agent runs as nexus-agent (non-root)
	updateCmd := exec.Command("/usr/bin/sudo", "/usr/bin/apt-get", "update")
	updateCmd.Env = aptEnv()
	if out, err := updateCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("apt-get update failed: %w: %s", err, string(out))
	}

	// Step 2: list the upgradables (no sudo needed)
	cmd := exec.Command("/usr/bin/apt", "list", "--upgradable")
	cmd.Env = aptEnv()
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("apt list failed: %w", err)
	}

	// Set of packages that `apt-get upgrade` would actually install, to
	// distinguish phased/kept-back (deferred) ones from the rest.
	installable := aptInstallableSet()

	// Slice initialized non-nil: in Go a nil slice serializes to `null`
	// (not `[]`), which crashed the front (`packages.filter` of null).
	updates := make([]PendingUpdate, 0)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.Contains(line, "Listing...") {
			continue
		}

		// Expected format: package/source version arch [upgradable from: old_version]
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		// Locale-independent safeguard: a real upgradable line always starts
		// with "name/suite". Translated headers/notes (e.g. "En train de
		// lister…") have no "/" → we ignore them.
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

		// Deferred if present in the upgradable list but absent from the set
		// that `apt-get upgrade` would install (installable == nil => we failed
		// to simulate, so we mark nothing rather than lie).
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

// aptInstallableSet simulates `apt-get upgrade` and returns the set of
// packages that would actually be updated ("Inst ..." lines). Phased updates
// and kept-back ones are absent from it — this is exactly what "X updates can
// be applied immediately" counts.
// Returns nil on failure (in which case no package is marked as deferred).
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
	// ABSOLUTE path, HARDCODED arguments
	cmd := exec.Command("/usr/bin/dnf", "check-update", "-q")
	output, _ := cmd.Output() // dnf check-update returns exit code 100 if updates exist

	updates := make([]PendingUpdate, 0)
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
	// ABSOLUTE path, HARDCODED arguments
	cmd := exec.Command("/usr/bin/yum", "check-update", "-q")
	output, _ := cmd.Output()

	updates := make([]PendingUpdate, 0)
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
