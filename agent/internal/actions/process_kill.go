package actions

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

func init() { Register(&ProcessKillAction{}) }

type ProcessKillAction struct{}

func (a *ProcessKillAction) ID() string         { return "process.kill" }
func (a *ProcessKillAction) Capability() string  { return "scripts" }

func (a *ProcessKillAction) Validate(params map[string]interface{}) error {
	pidRaw, ok := params["pid"]
	if !ok {
		return fmt.Errorf("required parameter 'pid' missing")
	}

	var pid int
	switch v := pidRaw.(type) {
	case float64:
		pid = int(v)
	case int:
		pid = v
	case string:
		var err error
		pid, err = strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("invalid pid: %s", v)
		}
	default:
		return fmt.Errorf("pid must be a number")
	}

	if pid <= 1 {
		return fmt.Errorf("cannot kill PID %d (protected)", pid)
	}

	// Validate signal if provided
	if sig, ok := params["signal"].(string); ok {
		validSignals := map[string]bool{
			"SIGTERM": true, "SIGKILL": true, "SIGHUP": true,
			"SIGINT": true, "SIGUSR1": true, "SIGUSR2": true,
			"15": true, "9": true, "1": true, "2": true,
		}
		if !validSignals[strings.ToUpper(sig)] {
			return fmt.Errorf("invalid signal: %s", sig)
		}
	}

	return nil
}

func (a *ProcessKillAction) Execute(params map[string]interface{}) (interface{}, error) {
	var pid int
	switch v := params["pid"].(type) {
	case float64:
		pid = int(v)
	case int:
		pid = v
	case string:
		pid, _ = strconv.Atoi(v)
	}

	signal := "SIGTERM"
	if sig, ok := params["signal"].(string); ok && sig != "" {
		signal = strings.ToUpper(sig)
	}

	// Via sudo — l'agent tourne sous nexus-agent (non-root)
	cmd := exec.Command("/usr/bin/sudo", "/bin/kill", fmt.Sprintf("-%s", signal), strconv.Itoa(pid))
	output, err := cmd.CombinedOutput()

	return map[string]interface{}{
		"success": err == nil,
		"pid":     pid,
		"signal":  signal,
		"output":  strings.TrimSpace(string(output)),
	}, nil
}
