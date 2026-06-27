package actions

import (
	"os"
	"testing"
)

// NEXUS-AGENT-004 — la garde refuse le process de l'agent lui-même (désarmement
// watchdog). Test déterministe : protectedKillTarget(os.Getpid()) doit refuser.
func TestProcessKill_RefusesOwnPid(t *testing.T) {
	if protectedKillTarget(os.Getpid()) == "" {
		t.Fatal("la garde laisse l'agent se tuer lui-même")
	}
	// Un PID arbitraire qui n'est ni l'agent ni un service critique → autorisé
	// (pid 999999 improbablement un MainPID critique sur l'hôte de CI).
	if r := protectedKillTarget(999999); r != "" {
		t.Logf("pid 999999 refusé (%s) — acceptable s'il matche un service ; informatif", r)
	}
}
