package actions

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// NEXUS-AGENT-004 — services whose MainPID must NEVER be killed by
// process.kill (would disarm the watchdog-reverts if the agent is killed; DoS/lockout
// if a critical daemon is killed). Aligned with the critical set of
// machine-protection.ts. The PID is resolved LIVE at kill time (a service that
// restarts has a new PID — a cache would let the kill of the new one through).
var killProtectedServices = []string{
	"nexus-agent", "ssh", "sshd", "docker", "nginx",
	"postgresql", "postgres", "mariadb", "mysql", "containerd",
}

// serviceMainPID resolves the MainPID of a systemd service NOW (never cached).
func serviceMainPID(svc string) int {
	out, err := exec.Command("systemctl", "show", "-p", "MainPID", "--value", svc).Output()
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return pid
}

// protectedKillTarget returns a non-empty reason if `pid` must not be killed:
// the agent's own process, or the MainPID (resolved LIVE) of a critical service.
func protectedKillTarget(pid int) string {
	if pid == os.Getpid() {
		return "agent's own process"
	}
	for _, svc := range killProtectedServices {
		if mainPid := serviceMainPID(svc); mainPid > 0 && mainPid == pid {
			return "critical/protected service " + svc
		}
	}
	return ""
}

func init() { Register(&ProcessKillAction{}) }

type ProcessKillAction struct{}

func (a *ProcessKillAction) ID() string         { return "process.kill" }
func (a *ProcessKillAction) Capability() string { return "scripts" }

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

	// NEXUS-AGENT-004 — authoritative guard (sudoers cannot denylist a
	// PID). LIVE resolution at kill time. Refuses the agent itself (watchdog
	// disarming) and critical daemons (DoS/lockout) — not covered by isCritical
	// (based on service NAMES) nor by the systemctl block (here it's a raw
	// kill).
	if reason := protectedKillTarget(pid); reason != "" {
		return nil, fmt.Errorf("refusing to kill PID %d (%s)", pid, reason)
	}

	signal := "SIGTERM"
	if sig, ok := params["signal"].(string); ok && sig != "" {
		signal = strings.ToUpper(sig)
	}

	// Via sudo — the agent runs as nexus-agent (non-root)
	cmd := exec.Command("/usr/bin/sudo", "/bin/kill", fmt.Sprintf("-%s", signal), strconv.Itoa(pid))
	output, err := cmd.CombinedOutput()

	return map[string]interface{}{
		"success": err == nil,
		"pid":     pid,
		"signal":  signal,
		"output":  strings.TrimSpace(string(output)),
	}, nil
}
