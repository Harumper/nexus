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

// ProgressCallback is called for each output line
// Enables progress streaming to the server
type ProgressCallback func(line string, percent int)

// Global variable for the progress callback
// Will be set by main.go when it connects the WS client
var OnUpdateProgress ProgressCallback

// ===================== Full Update =====================

type SystemUpdateAction struct{}

func (a *SystemUpdateAction) ID() string         { return "system.update" }
func (a *SystemUpdateAction) Capability() string { return "updates" }

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
func (a *SystemUpdateSecurityAction) Capability() string { return "updates" }

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

// aptUpdateEnv forces the C locale during the upgrade: the trace is then in
// English (standard for apt logs) and the progress heuristic that counts
// "Unpacking"/"Setting up" stays reliable whatever the system language.
func aptUpdateEnv() []string {
	return append(os.Environ(),
		"DEBIAN_FRONTEND=noninteractive",
		"LC_ALL=C",
		"LANG=C",
	)
}

// ===================== Execution (HARDCODED commands) =====================

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
		// Step 1: apt-get update (refresh index)
		// Via sudo — the agent runs as nexus-agent (non-root)
		sendProgress("Updating package index...", 10)
		updateCmd := exec.Command("/usr/bin/sudo", "/usr/bin/apt-get", "update")
		updateCmd.Env = aptUpdateEnv()
		if out, err := updateCmd.CombinedOutput(); err != nil {
			return &collector.UpdateResult{
				Success:     false,
				Output:      string(out),
				ErrorOutput: err.Error(),
			}, nil
		}

		// Step 2: apt-get upgrade
		// "-q" (and not "-qq"): we keep the "Unpacking"/"Setting up" lines
		// to feed the real-time trace; "-qq" would suppress them.
		sendProgress("Installing updates...", 30)
		if securityOnly {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/unattended-upgrades", "--minimal_upgrade_steps")
		} else {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/apt-get", "upgrade", "-y", "-q")
		}
		cmd.Env = aptUpdateEnv()

	case collector.PMDnf:
		sendProgress("Installing updates...", 20)
		if securityOnly {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/dnf", "update", "--security", "-y", "-q")
		} else {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/dnf", "upgrade", "-y", "-q")
		}

	case collector.PMYum:
		sendProgress("Installing updates...", 20)
		if securityOnly {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/yum", "update", "--security", "-y", "-q")
		} else {
			cmd = exec.Command("/usr/bin/sudo", "/usr/bin/yum", "update", "-y", "-q")
		}

	default:
		return nil, fmt.Errorf("unsupported package manager: %s", pm)
	}

	// Execute with output streaming
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	cmd.Stderr = cmd.Stdout // Combine stderr into stdout

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start update: %w", err)
	}

	// Read the output line by line for streaming
	packageCount := 0
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		log.Printf("[Update] %s", line)

		// Count the installed packages
		if strings.Contains(line, "Unpacking") || strings.Contains(line, "Setting up") ||
			strings.Contains(line, "Installing") || strings.Contains(line, "Updating") {
			packageCount++
		}

		// Estimate progress
		percent := 30 + min(packageCount*2, 60)
		sendProgress(line, percent)
	}

	err = cmd.Wait()
	sendProgress("Done.", 100)

	// Drain the rest of stdout if necessary
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
