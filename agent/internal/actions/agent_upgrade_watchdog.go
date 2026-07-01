package actions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// NEXUS-SELF-UPGRADE-005 — watchdog-revert applied to auto-upgrade (the only
// self mutator that skipped the snapshot→apply→revert-if-not-confirmed pattern of
// firewall/netplan/sshd). A valid-but-bad release must not brick
// the host with no way back.
//
// Flow:
//  1. before installing the new binary: snapshot the current one → .prev (root);
//  2. after install: "upgrade pending" marker (expected SHA);
//  3. at boot (RecoverPendingUpgrade): if a marker exists and the current
//     binary is indeed the new one, we ARM a dead-man's switch — if the agent does
//     not CONFIRM (reconnection + auth) within the delay, we restore .prev and
//     restart on the known-good binary;
//  4. ConfirmUpgrade (called on successful reconnection) cancels the switch + erases
//     the marker. We do NOT delete .prev (fallback kept, overwritten at the next
//     upgrade).
const (
	prevBinPath       = "/var/lib/nexus-agent/nexus-agent.prev"
	upgradeMarkerPath = "/var/lib/nexus-agent/upgrade-pending"
	agentFinalBinPath = "/usr/local/bin/nexus-agent"
	upgradeGrace      = 180 * time.Second
)

var (
	upgradeMu          sync.Mutex
	upgradeRevertTimer *time.Timer
)

func fileSHA256(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

// snapshotPreviousBinary copies the current binary to .prev (root-owned) BEFORE
// overwriting — we never delete the only backup copy.
func snapshotPreviousBinary() error {
	out, err := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", agentFinalBinPath, prevBinPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("snapshot .prev: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// markUpgradePending writes the marker (expected SHA of the new binary).
func markUpgradePending(expectedSHA string) error {
	return os.WriteFile(upgradeMarkerPath, []byte(expectedSHA+"\n"), 0600)
}

// RecoverPendingUpgrade — called at BOOT (like RecoverPendingSnapshots/Netplan/
// Sshd). Arms the dead-man's switch if an upgrade is pending.
func RecoverPendingUpgrade() {
	data, err := os.ReadFile(upgradeMarkerPath)
	if err != nil {
		return // no upgrade pending
	}
	expected := strings.TrimSpace(string(data))

	cur, err := fileSHA256(agentFinalBinPath)
	if err == nil && cur != expected {
		// The current binary is NOT the expected new one → restore the known-good.
		log.Printf("[Upgrade] current binary ≠ expected (%s ≠ %s) → restoring .prev", cur, expected)
		revertUpgrade()
		return
	}

	upgradeMu.Lock()
	upgradeRevertTimer = time.AfterFunc(upgradeGrace, func() {
		log.Printf("[Upgrade] no confirmation within %v → restoring .prev (dead-man's switch)", upgradeGrace)
		revertUpgrade()
	})
	upgradeMu.Unlock()
	log.Printf("[Upgrade] new binary started; health-gate armed (%v until confirmation)", upgradeGrace)
}

// ConfirmUpgrade — called on successful reconnection + auth. Cancels the switch and
// erases the marker: the upgrade is validated.
func ConfirmUpgrade() {
	upgradeMu.Lock()
	if upgradeRevertTimer != nil {
		upgradeRevertTimer.Stop()
		upgradeRevertTimer = nil
	}
	upgradeMu.Unlock()
	if _, err := os.Stat(upgradeMarkerPath); err == nil {
		os.Remove(upgradeMarkerPath)
		log.Printf("[Upgrade] confirmed (reconnection OK); marker erased (.prev kept as fallback)")
	}
}

// revertUpgrade restores the .prev backup binary and restarts.
func revertUpgrade() {
	if _, err := os.Stat(prevBinPath); err != nil {
		log.Printf("[Upgrade] .prev missing — revert impossible")
		return
	}
	out, err := exec.Command("/usr/bin/sudo", "/usr/bin/install", "-m", "755", prevBinPath, agentFinalBinPath).CombinedOutput()
	if err != nil {
		log.Printf("[Upgrade] revert install failed: %v %s", err, strings.TrimSpace(string(out)))
		return
	}
	os.Remove(upgradeMarkerPath)
	log.Printf("[Upgrade] binary restored from .prev → restarting on the known-good")
	os.Exit(1) // Restart=always restarts the agent on the restored binary
}
