package actions

import (
	"os"
	"testing"
)

// NEXUS-AGENT-004 — the guard refuses the agent's own process (watchdog
// disarming). Deterministic test: protectedKillTarget(os.Getpid()) must refuse.
func TestProcessKill_RefusesOwnPid(t *testing.T) {
	if protectedKillTarget(os.Getpid()) == "" {
		t.Fatal("the guard lets the agent kill itself")
	}
	// An arbitrary PID that is neither the agent nor a critical service → allowed
	// (pid 999999 unlikely to be a critical MainPID on the CI host).
	if r := protectedKillTarget(999999); r != "" {
		t.Logf("pid 999999 refused (%s) — acceptable if it matches a service; informational", r)
	}
}
