package actions

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func init() {
	Register(&SystemServicesFailedAction{})
	Register(&SystemTimersFailedAction{})
	Register(&SystemUpdatesAvailableAction{})
	Register(&SystemHealthSummaryAction{})
}

// ═══════════════════════════════════════════════════════════════
// system.health_summary: compiles services_failed + timers_failed +
// updates_available into a single response (for the alert-engine that polls
// periodically).
// ═══════════════════════════════════════════════════════════════

type SystemHealthSummaryAction struct{}

func (a *SystemHealthSummaryAction) ID() string                              { return "system.health_summary" }
func (a *SystemHealthSummaryAction) Capability() string                      { return "monitoring" }
func (a *SystemHealthSummaryAction) Validate(_ map[string]interface{}) error { return nil }

func (a *SystemHealthSummaryAction) Execute(_ map[string]interface{}) (interface{}, error) {
	servicesAct := &SystemServicesFailedAction{}
	timersAct := &SystemTimersFailedAction{}
	updatesAct := &SystemUpdatesAvailableAction{}

	services, _ := servicesAct.Execute(nil)
	timers, _ := timersAct.Execute(nil)
	updates, _ := updatesAct.Execute(nil)

	return map[string]interface{}{
		"services": services,
		"timers":   timers,
		"updates":  updates,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// system.services_failed: systemctl list-units --failed --type=service
// ═══════════════════════════════════════════════════════════════

type SystemServicesFailedAction struct{}

func (a *SystemServicesFailedAction) ID() string                              { return "system.services_failed" }
func (a *SystemServicesFailedAction) Capability() string                      { return "monitoring" }
func (a *SystemServicesFailedAction) Validate(_ map[string]interface{}) error { return nil }

func (a *SystemServicesFailedAction) Execute(_ map[string]interface{}) (interface{}, error) {
	cmd := exec.Command("/usr/bin/systemctl", "list-units",
		"--state=failed",
		"--type=service",
		"--no-pager",
		"--output=json")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl list-units failed: %w", err)
	}
	var units []map[string]interface{}
	if err := json.Unmarshal(out, &units); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}
	// Extract just name + description to keep it lightweight
	failed := make([]map[string]interface{}, 0, len(units))
	for _, u := range units {
		failed = append(failed, map[string]interface{}{
			"unit":        u["unit"],
			"description": u["description"],
			"active":      u["active"],
			"sub":         u["sub"],
		})
	}
	return map[string]interface{}{
		"failed": failed,
		"count":  len(failed),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// system.timers_failed: timers whose LastTriggerResult is not success
// ═══════════════════════════════════════════════════════════════

type SystemTimersFailedAction struct{}

func (a *SystemTimersFailedAction) ID() string                              { return "system.timers_failed" }
func (a *SystemTimersFailedAction) Capability() string                      { return "monitoring" }
func (a *SystemTimersFailedAction) Validate(_ map[string]interface{}) error { return nil }

func (a *SystemTimersFailedAction) Execute(_ map[string]interface{}) (interface{}, error) {
	// List all timers
	listCmd := exec.Command("/usr/bin/systemctl", "list-timers", "--all", "--no-pager", "--output=json")
	out, err := listCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl list-timers: %w", err)
	}
	var timers []map[string]interface{}
	if err := json.Unmarshal(out, &timers); err != nil {
		return nil, fmt.Errorf("parse timers: %w", err)
	}

	failed := []map[string]interface{}{}
	for _, t := range timers {
		unit, _ := t["unit"].(string)
		if unit == "" {
			continue
		}
		// Retrieve the status of the service activated by the timer
		activates, _ := t["activates"].(string)
		if activates == "" {
			continue
		}
		// Check ExecMainStatus via systemctl show
		showCmd := exec.Command("/usr/bin/systemctl", "show", activates,
			"--property=ExecMainStatus,ExecMainCode,Result,ActiveState")
		showOut, err := showCmd.Output()
		if err != nil {
			continue
		}
		props := parseSystemctlProps(showOut)
		if props["Result"] != "success" && props["Result"] != "" {
			failed = append(failed, map[string]interface{}{
				"timer":       unit,
				"service":     activates,
				"result":      props["Result"],
				"exit_status": props["ExecMainStatus"],
				"next":        t["next"],
				"last":        t["last"],
			})
		}
	}
	return map[string]interface{}{
		"failed": failed,
		"count":  len(failed),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// system.updates_available: just a count
// (reuses system.package_list if needed, here a simple wrapper)
// ═══════════════════════════════════════════════════════════════

type SystemUpdatesAvailableAction struct{}

func (a *SystemUpdatesAvailableAction) ID() string                              { return "system.updates_available" }
func (a *SystemUpdatesAvailableAction) Capability() string                      { return "monitoring" }
func (a *SystemUpdatesAvailableAction) Validate(_ map[string]interface{}) error { return nil }

func (a *SystemUpdatesAvailableAction) Execute(_ map[string]interface{}) (interface{}, error) {
	// apt list --upgradable does not require sudo in list mode
	// LC_ALL=C: deterministic output regardless of the system language
	cmd := exec.Command("/usr/bin/apt", "list", "--upgradable", "-qq")
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive", "LC_ALL=C", "LANG=C")
	out, _ := cmd.Output()
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	count := 0
	security := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "WARNING") {
			continue
		}
		count++
		if strings.Contains(line, "-security") {
			security++
		}
	}
	return map[string]interface{}{
		"count":    count,
		"security": security,
	}, nil
}

func parseSystemctlProps(out []byte) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, "="); i > 0 {
			m[line[:i]] = strings.TrimSpace(line[i+1:])
		}
	}
	return m
}
