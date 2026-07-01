package actions

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func init() {
	Register(&CronListAction{})
	Register(&TimerListAction{})
	Register(&TimerEnableAction{})
	Register(&TimerDisableAction{})
}

// Regex for valid timer names (same as services)
var timerNameRegex = regexp.MustCompile(`^[a-zA-Z0-9@_.\-]+(\.timer)?$`)

// ═══════════════════════════════════════════════════════════════
// cron.list: parse /etc/crontab + /etc/cron.d/* + user crontabs
// ═══════════════════════════════════════════════════════════════

type CronJob struct {
	Source   string `json:"source"`   // "/etc/crontab", "/etc/cron.d/foo", "user:root"
	User     string `json:"user"`     // Execution user
	Schedule string `json:"schedule"` // "0 3 * * *" or "@daily"
	Command  string `json:"command"`
}

type CronListAction struct{}

func (a *CronListAction) ID() string                              { return "cron.list" }
func (a *CronListAction) Capability() string                      { return "monitoring" }
func (a *CronListAction) Validate(_ map[string]interface{}) error { return nil }

func (a *CronListAction) Execute(_ map[string]interface{}) (interface{}, error) {
	jobs := []CronJob{}

	// /etc/crontab (6 fields: min h dom mon dow user command)
	jobs = append(jobs, parseSystemCrontab("/etc/crontab")...)

	// /etc/cron.d/*
	if entries, err := os.ReadDir("/etc/cron.d"); err == nil {
		for _, e := range entries {
			if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			jobs = append(jobs, parseSystemCrontab(filepath.Join("/etc/cron.d", e.Name()))...)
		}
	}

	// user crontabs via `sudo crontab -l -u <user>` would be too intrusive.
	// We read /var/spool/cron/crontabs if accessible (would typically require sudo).
	// For v1 we stick to the system crontabs.

	return map[string]interface{}{
		"jobs":  jobs,
		"count": len(jobs),
	}, nil
}

func parseSystemCrontab(path string) []CronJob {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	source := path
	var jobs []CronJob
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Skip variable lines (NAME=value)
		if strings.Contains(line, "=") && !strings.ContainsAny(line, " \t") {
			continue
		}
		// Format: min h dom mon dow user command... (or @daily user command...)
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		var schedule, user, command string
		if strings.HasPrefix(fields[0], "@") {
			// @daily user command
			if len(fields) < 3 {
				continue
			}
			schedule = fields[0]
			user = fields[1]
			command = strings.Join(fields[2:], " ")
		} else {
			// 5 fields + user + command
			schedule = strings.Join(fields[0:5], " ")
			user = fields[5]
			command = strings.Join(fields[6:], " ")
		}
		jobs = append(jobs, CronJob{
			Source:   source,
			User:     user,
			Schedule: schedule,
			Command:  command,
		})
	}
	return jobs
}

// ═══════════════════════════════════════════════════════════════
// timer.list : systemctl list-timers --all --no-pager -o json
// ═══════════════════════════════════════════════════════════════

type TimerListAction struct{}

func (a *TimerListAction) ID() string                              { return "timer.list" }
func (a *TimerListAction) Capability() string                      { return "monitoring" }
func (a *TimerListAction) Validate(_ map[string]interface{}) error { return nil }

func (a *TimerListAction) Execute(_ map[string]interface{}) (interface{}, error) {
	cmd := exec.Command("/usr/bin/systemctl", "list-timers", "--all", "--no-pager", "--output", "json")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl list-timers failed: %w", err)
	}
	var timers []map[string]interface{}
	if err := json.Unmarshal(out, &timers); err != nil {
		// Fallback if no JSON support (old systemd)
		return nil, fmt.Errorf("failed to parse timers json: %w", err)
	}

	// Enrich with the enabled/disabled state via is-enabled (batch)
	for i, t := range timers {
		if unit, ok := t["unit"].(string); ok {
			enabledCmd := exec.Command("/usr/bin/systemctl", "is-enabled", unit)
			enabledOut, _ := enabledCmd.Output()
			timers[i]["enabled_state"] = strings.TrimSpace(string(enabledOut))
		}
	}

	return map[string]interface{}{
		"timers": timers,
		"count":  len(timers),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// timer.enable / timer.disable : systemctl enable/disable <name>.timer
// ═══════════════════════════════════════════════════════════════

type TimerEnableAction struct{}

func (a *TimerEnableAction) ID() string         { return "timer.enable" }
func (a *TimerEnableAction) Capability() string { return "system_control" }

func (a *TimerEnableAction) Validate(params map[string]interface{}) error {
	return validateTimerName(params)
}

func (a *TimerEnableAction) Execute(params map[string]interface{}) (interface{}, error) {
	return runTimerCommand("enable", params)
}

type TimerDisableAction struct{}

func (a *TimerDisableAction) ID() string         { return "timer.disable" }
func (a *TimerDisableAction) Capability() string { return "system_control" }

func (a *TimerDisableAction) Validate(params map[string]interface{}) error {
	return validateTimerName(params)
}

func (a *TimerDisableAction) Execute(params map[string]interface{}) (interface{}, error) {
	return runTimerCommand("disable", params)
}

func validateTimerName(params map[string]interface{}) error {
	name, ok := params["name"].(string)
	if !ok || name == "" {
		return fmt.Errorf("required parameter 'name' missing")
	}
	if len(name) > 128 {
		return fmt.Errorf("timer name too long")
	}
	if !timerNameRegex.MatchString(name) {
		return fmt.Errorf("invalid timer name")
	}
	return nil
}

func runTimerCommand(verb string, params map[string]interface{}) (interface{}, error) {
	name := params["name"].(string)
	if !strings.HasSuffix(name, ".timer") {
		name = name + ".timer"
	}
	// NEXUS-AGENT-006: service control via the compiled privhelper (canonicalized
	// verb + unit, non-injectable options).
	cmd := exec.Command("sudo", "-n", nexusAgentBin, "privhelper", "svc", verb, name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("systemctl %s %s failed: %s", verb, name, strings.TrimSpace(string(out)))
	}
	return map[string]interface{}{
		"name":   name,
		"action": verb,
		"output": strings.TrimSpace(string(out)),
	}, nil
}
