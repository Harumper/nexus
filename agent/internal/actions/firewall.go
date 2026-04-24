package actions

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

func init() {
	Register(&FirewallStatusAction{})
	Register(&FirewallAllowAction{})
	Register(&FirewallDenyAction{})
	Register(&FirewallRuleRemoveAction{})
	Register(&FirewallEnableAction{})
	Register(&FirewallDisableAction{})
}

const (
	watchdogDuration = 60 * time.Second
	snapshotDir      = "/var/lib/nexus-agent"
)

// PendingRevert represente une modification firewall en attente de confirmation.
type PendingRevert struct {
	RequestID    string
	SnapshotFile string
	UfwEnabled   bool
	Timer        *time.Timer
	CreatedAt    time.Time
}

var (
	pendingMu sync.Mutex
	pending   = map[string]*PendingRevert{}
)

// HandleConfirm est appele par main.go quand un message action.confirm est recu du backend.
func HandleConfirm(requestID string) {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	p, ok := pending[requestID]
	if !ok {
		log.Printf("[Firewall] Confirm received for unknown request_id=%s (maybe already reverted)", requestID)
		return
	}
	p.Timer.Stop()
	if p.SnapshotFile != "" {
		os.Remove(p.SnapshotFile)
	}
	delete(pending, requestID)
	log.Printf("[Firewall] Change confirmed for request_id=%s, snapshot discarded", requestID)
}

// RecoverPendingSnapshots est appele au demarrage de l'agent.
// Si des fichiers de snapshot existent (agent a crash pendant la fenetre 60s),
// revert immediatement.
func RecoverPendingSnapshots() {
	entries, err := os.ReadDir(snapshotDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "firewall-snapshot-") || !strings.HasSuffix(name, ".iptables") {
			continue
		}
		snapshotFile := filepath.Join(snapshotDir, name)
		log.Printf("[Firewall] Recovering pending snapshot %s — reverting", snapshotFile)
		if err := restoreFromSnapshot(snapshotFile, false); err != nil {
			log.Printf("[Firewall] Revert failed: %v", err)
		}
		os.Remove(snapshotFile)
	}
}

func snapshotIptables(requestID string) (string, error) {
	os.MkdirAll(snapshotDir, 0700)
	snapshotFile := filepath.Join(snapshotDir, fmt.Sprintf("firewall-snapshot-%s.iptables", requestID))
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/iptables-save")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("iptables-save failed: %w", err)
	}
	if err := os.WriteFile(snapshotFile, out, 0600); err != nil {
		return "", fmt.Errorf("write snapshot: %w", err)
	}
	return snapshotFile, nil
}

func ufwIsActive() bool {
	out, _ := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "status").Output()
	return strings.Contains(string(out), "Status: active")
}

func restoreFromSnapshot(snapshotFile string, ufwShouldBeEnabled bool) error {
	// iptables-restore lit depuis stdin
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/iptables-restore")
	data, err := os.ReadFile(snapshotFile)
	if err != nil {
		return fmt.Errorf("read snapshot: %w", err)
	}
	cmd.Stdin = strings.NewReader(string(data))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("iptables-restore: %w: %s", err, string(out))
	}
	// Restore ufw state
	if ufwShouldBeEnabled && !ufwIsActive() {
		exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "enable").Run()
	} else if !ufwShouldBeEnabled && ufwIsActive() {
		exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "disable").Run()
	}
	return nil
}

// registerPendingRevert snapshot + arme le timer. Retourne un request_id.
func registerPendingRevert(requestID string) (*PendingRevert, error) {
	pendingMu.Lock()
	// Serialize : rejeter si un revert est deja pending
	if len(pending) > 0 {
		pendingMu.Unlock()
		return nil, fmt.Errorf("another firewall change is pending confirmation; wait or confirm it first")
	}
	pendingMu.Unlock()

	ufwEnabled := ufwIsActive()
	snapshotFile, err := snapshotIptables(requestID)
	if err != nil {
		return nil, err
	}

	p := &PendingRevert{
		RequestID:    requestID,
		SnapshotFile: snapshotFile,
		UfwEnabled:   ufwEnabled,
		CreatedAt:    time.Now(),
	}
	p.Timer = time.AfterFunc(watchdogDuration, func() {
		pendingMu.Lock()
		defer pendingMu.Unlock()
		if _, still := pending[requestID]; !still {
			return
		}
		log.Printf("[Firewall] Watchdog expired for request_id=%s — reverting", requestID)
		if err := restoreFromSnapshot(p.SnapshotFile, p.UfwEnabled); err != nil {
			log.Printf("[Firewall] Revert failed: %v", err)
		}
		os.Remove(p.SnapshotFile)
		delete(pending, requestID)
	})

	pendingMu.Lock()
	pending[requestID] = p
	pendingMu.Unlock()

	return p, nil
}

// ===================== firewall.status (read-only) =====================

type FirewallStatusAction struct{}

func (a *FirewallStatusAction) ID() string         { return "firewall.status" }
func (a *FirewallStatusAction) Capability() string { return "firewall" }
func (a *FirewallStatusAction) Validate(params map[string]interface{}) error {
	return nil
}
func (a *FirewallStatusAction) Execute(params map[string]interface{}) (interface{}, error) {
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "status", "numbered")
	out, err := cmd.CombinedOutput()
	outStr := string(out)
	// Parse ufw status output
	enabled := strings.Contains(outStr, "Status: active")

	pendingMu.Lock()
	pendingList := make([]map[string]interface{}, 0, len(pending))
	for _, p := range pending {
		pendingList = append(pendingList, map[string]interface{}{
			"request_id":         p.RequestID,
			"created_at":         p.CreatedAt.Format(time.RFC3339),
			"expires_in_seconds": int(watchdogDuration.Seconds() - time.Since(p.CreatedAt).Seconds()),
		})
	}
	pendingMu.Unlock()

	return map[string]interface{}{
		"enabled":  enabled,
		"raw":      outStr,
		"pending":  pendingList,
		"error":    err != nil,
	}, nil
}

// ===================== firewall.allow =====================

type FirewallAllowAction struct{}

func (a *FirewallAllowAction) ID() string         { return "firewall.allow" }
func (a *FirewallAllowAction) Capability() string { return "firewall" }
func (a *FirewallAllowAction) Validate(params map[string]interface{}) error {
	rule, ok := params["rule"].(string)
	if !ok || rule == "" {
		return fmt.Errorf("required parameter 'rule' missing (e.g. '80/tcp' or 'from 10.0.0.0/8')")
	}
	if len(rule) > 256 {
		return fmt.Errorf("rule too long")
	}
	// Forbid shell metacharacters — ufw parses the rule but we belt-and-suspenders
	for _, c := range rule {
		if c == ';' || c == '|' || c == '&' || c == '`' || c == '$' || c == '\n' {
			return fmt.Errorf("invalid character in rule")
		}
	}
	return nil
}
func (a *FirewallAllowAction) Execute(params map[string]interface{}) (interface{}, error) {
	rule := params["rule"].(string)
	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("firewall-%d", time.Now().UnixNano())
	}
	pr, err := registerPendingRevert(reqID)
	if err != nil {
		return nil, err
	}
	args := append([]string{"/usr/sbin/ufw", "allow"}, strings.Fields(rule)...)
	cmd := exec.Command("/usr/bin/sudo", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// Revert immediatement en cas d'echec
		HandleConfirm(reqID) // libere le pending (timer + snapshot)
		return nil, fmt.Errorf("ufw allow failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":              true,
		"request_id":           reqID,
		"watchdog_expires_in":  int(watchdogDuration.Seconds()),
		"watchdog_expires_at":  pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":               string(output),
	}, nil
}

// ===================== firewall.deny =====================

type FirewallDenyAction struct{}

func (a *FirewallDenyAction) ID() string         { return "firewall.deny" }
func (a *FirewallDenyAction) Capability() string { return "firewall" }
func (a *FirewallDenyAction) Validate(params map[string]interface{}) error {
	// meme validation que allow
	allow := FirewallAllowAction{}
	return allow.Validate(params)
}
func (a *FirewallDenyAction) Execute(params map[string]interface{}) (interface{}, error) {
	rule := params["rule"].(string)
	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("firewall-%d", time.Now().UnixNano())
	}
	pr, err := registerPendingRevert(reqID)
	if err != nil {
		return nil, err
	}
	args := append([]string{"/usr/sbin/ufw", "deny"}, strings.Fields(rule)...)
	cmd := exec.Command("/usr/bin/sudo", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		HandleConfirm(reqID)
		return nil, fmt.Errorf("ufw deny failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":              true,
		"request_id":           reqID,
		"watchdog_expires_in":  int(watchdogDuration.Seconds()),
		"watchdog_expires_at":  pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":               string(output),
	}, nil
}

// ===================== firewall.rule_remove =====================

type FirewallRuleRemoveAction struct{}

func (a *FirewallRuleRemoveAction) ID() string         { return "firewall.rule_remove" }
func (a *FirewallRuleRemoveAction) Capability() string { return "firewall" }
func (a *FirewallRuleRemoveAction) Validate(params map[string]interface{}) error {
	n, ok := toInt(params["number"])
	if !ok || n < 1 {
		return fmt.Errorf("required parameter 'number' must be positive integer")
	}
	return nil
}
func (a *FirewallRuleRemoveAction) Execute(params map[string]interface{}) (interface{}, error) {
	n, _ := toInt(params["number"])
	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("firewall-%d", time.Now().UnixNano())
	}
	pr, err := registerPendingRevert(reqID)
	if err != nil {
		return nil, err
	}
	// `ufw --force delete N` pour ne pas demander confirmation interactive
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "--force", "delete", strconv.Itoa(n))
	output, err := cmd.CombinedOutput()
	if err != nil {
		HandleConfirm(reqID)
		return nil, fmt.Errorf("ufw delete failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":              true,
		"request_id":           reqID,
		"watchdog_expires_in":  int(watchdogDuration.Seconds()),
		"watchdog_expires_at":  pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":               string(output),
	}, nil
}

// ===================== firewall.enable =====================

type FirewallEnableAction struct{}

func (a *FirewallEnableAction) ID() string         { return "firewall.enable" }
func (a *FirewallEnableAction) Capability() string { return "firewall" }
func (a *FirewallEnableAction) Validate(params map[string]interface{}) error {
	return nil
}
func (a *FirewallEnableAction) Execute(params map[string]interface{}) (interface{}, error) {
	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("firewall-%d", time.Now().UnixNano())
	}
	pr, err := registerPendingRevert(reqID)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "--force", "enable")
	output, err := cmd.CombinedOutput()
	if err != nil {
		HandleConfirm(reqID)
		return nil, fmt.Errorf("ufw enable failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":              true,
		"request_id":           reqID,
		"watchdog_expires_in":  int(watchdogDuration.Seconds()),
		"watchdog_expires_at":  pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":               string(output),
	}, nil
}

// ===================== firewall.disable =====================

type FirewallDisableAction struct{}

func (a *FirewallDisableAction) ID() string         { return "firewall.disable" }
func (a *FirewallDisableAction) Capability() string { return "firewall" }
func (a *FirewallDisableAction) Validate(params map[string]interface{}) error {
	return nil
}
func (a *FirewallDisableAction) Execute(params map[string]interface{}) (interface{}, error) {
	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("firewall-%d", time.Now().UnixNano())
	}
	pr, err := registerPendingRevert(reqID)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "disable")
	output, err := cmd.CombinedOutput()
	if err != nil {
		HandleConfirm(reqID)
		return nil, fmt.Errorf("ufw disable failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":              true,
		"request_id":           reqID,
		"watchdog_expires_in":  int(watchdogDuration.Seconds()),
		"watchdog_expires_at":  pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":               string(output),
	}, nil
}
