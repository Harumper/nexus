package actions

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"

	"github.com/nexus/agent/internal/collector"
)

func init() {
	Register(&SystemUpdateAction{})
	Register(&SystemUpdateSecurityAction{})
}

// ProgressCallback est appelé pour chaque ligne de sortie
// Permet le streaming de progression vers le serveur
type ProgressCallback func(line string, percent int)

// Variable globale pour le callback de progression
// Sera défini par main.go quand il connecte le client WS
var OnUpdateProgress ProgressCallback

// ===================== Full Update =====================

type SystemUpdateAction struct{}

func (a *SystemUpdateAction) ID() string         { return "system.update" }
func (a *SystemUpdateAction) Capability() string  { return "updates" }

func (a *SystemUpdateAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *SystemUpdateAction) Execute(params map[string]interface{}) (interface{}, error) {
	pm := collector.DetectPackageManager()
	if pm == collector.PMUnknown {
		return nil, fmt.Errorf("no supported package manager found")
	}

	requestID, _ := params["request_id"].(string)

	log.Printf("[Update] Starting full system update with %s", pm)

	result, err := executeUpdate(pm, false, requestID)
	if err != nil {
		return nil, err
	}

	return result, nil
}

// ===================== Security-Only Update =====================

type SystemUpdateSecurityAction struct{}

func (a *SystemUpdateSecurityAction) ID() string         { return "system.update_security" }
func (a *SystemUpdateSecurityAction) Capability() string  { return "updates" }

func (a *SystemUpdateSecurityAction) Validate(params map[string]interface{}) error {
	return nil
}

func (a *SystemUpdateSecurityAction) Execute(params map[string]interface{}) (interface{}, error) {
	pm := collector.DetectPackageManager()
	if pm == collector.PMUnknown {
		return nil, fmt.Errorf("no supported package manager found")
	}

	requestID, _ := params["request_id"].(string)

	log.Printf("[Update] Starting security-only update with %s", pm)

	result, err := executeUpdate(pm, true, requestID)
	if err != nil {
		return nil, err
	}

	return result, nil
}

// aptUpdateEnv force la locale C pendant l'upgrade : la trace est alors en
// anglais (standard pour les logs apt) et l'heuristique de progression qui
// compte "Unpacking"/"Setting up" reste fiable quelle que soit la langue système.
func aptUpdateEnv() []string {
	return append(os.Environ(),
		"DEBIAN_FRONTEND=noninteractive",
		"LC_ALL=C",
		"LANG=C",
	)
}

// ===================== Exécution (commandes HARDCODÉES) =====================

func executeUpdate(pm collector.PackageManager, securityOnly bool, requestID string) (*collector.UpdateResult, error) {
	var cmd *exec.Cmd
	var outputLines []string

	sendProgress := func(line string, percent int) {
		outputLines = append(outputLines, line)
		if OnUpdateProgress != nil {
			OnUpdateProgress(line, percent)
		}
	}

	switch pm {
	case collector.PMApt:
		// Étape 1 : apt-get update (refresh index)
		// Via sudo — l'agent tourne sous nexus-agent (non-root)
		sendProgress("Mise à jour de l'index des paquets...", 10)
		updateCmd := exec.Command("/usr/bin/sudo", "/usr/bin/apt-get", "update")
		updateCmd.Env = aptUpdateEnv()
		if out, err := updateCmd.CombinedOutput(); err != nil {
			return &collector.UpdateResult{
				Success:     false,
				Output:      string(out),
				ErrorOutput: err.Error(),
			}, nil
		}

		// Étape 2 : apt-get upgrade
		// "-q" (et non "-qq") : on garde les lignes "Unpacking"/"Setting up"
		// pour alimenter la trace temps réel ; "-qq" les supprimait.
		sendProgress("Installation des mises à jour...", 30)
		if securityOnly {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/unattended-upgrades", "--minimal_upgrade_steps")
		} else {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/apt-get", "upgrade", "-y", "-q")
		}
		cmd.Env = aptUpdateEnv()

	case collector.PMDnf:
		sendProgress("Installation des mises à jour...", 20)
		if securityOnly {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/dnf", "update", "--security", "-y", "-q")
		} else {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/dnf", "upgrade", "-y", "-q")
		}

	case collector.PMYum:
		sendProgress("Installation des mises à jour...", 20)
		if securityOnly {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/yum", "update", "--security", "-y", "-q")
		} else {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/yum", "update", "-y", "-q")
		}

	default:
		return nil, fmt.Errorf("unsupported package manager: %s", pm)
	}

	// Exécuter avec streaming de la sortie
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	cmd.Stderr = cmd.Stdout // Combiner stderr dans stdout

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start update: %w", err)
	}

	// Lire la sortie ligne par ligne pour le streaming
	packageCount := 0
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		log.Printf("[Update] %s", line)

		// Compter les paquets installés
		if strings.Contains(line, "Unpacking") || strings.Contains(line, "Setting up") ||
			strings.Contains(line, "Installing") || strings.Contains(line, "Updating") {
			packageCount++
		}

		// Estimer la progression
		percent := 30 + min(packageCount*2, 60)
		sendProgress(line, percent)
	}

	err = cmd.Wait()
	sendProgress("Terminé.", 100)

	// Drainer le reste de stdout si nécessaire
	io.Copy(io.Discard, stdout)

	result := &collector.UpdateResult{
		Success:      err == nil,
		PackageCount: packageCount,
		Output:       strings.Join(outputLines, "\n"),
	}

	if err != nil {
		result.ErrorOutput = err.Error()
	}

	log.Printf("[Update] Complete. Success=%v, Packages=%d", result.Success, result.PackageCount)

	return result, nil
}
