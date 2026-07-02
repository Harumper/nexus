package actions

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	Register(&FirewallApplyPolicyAction{})
}

// Strict port or port/proto (no metacharacters) for the firewall assistant.
var firewallPortRegex = regexp.MustCompile(`^[0-9]{1,5}(/(tcp|udp))?$`)

const (
	watchdogDuration = 60 * time.Second
	snapshotDir      = "/var/lib/nexus-agent"
)

// PendingRevert represents a firewall change awaiting confirmation.
type PendingRevert struct {
	RequestID    string
	SnapshotFile string
	UfwEnabled   bool
	Timer        *time.Timer
	CreatedAt    time.Time
}

var (
	pendingMu        sync.Mutex
	pending          = map[string]*PendingRevert{}
	pendingReserving bool // in-flight reservation (check→snapshot→insert atomic)
)

// HandleConfirm is called by main.go when an action.confirm message is received from the backend.
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

// RecoverPendingSnapshots is called at agent startup.
// If snapshot files exist (agent crashed during the 60s window),
// revert immediately.
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
	// iptables-restore reads from stdin
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

// registerPendingRevert snapshot + arms the timer. Returns a request_id.
func registerPendingRevert(requestID string) (*PendingRevert, error) {
	// Serialize: reject if a revert is already pending OR being
	// reserved. The `reserving` flag closes the TOCTOU window: without it, two
	// concurrent requests (goroutines, distinct request_ids) would both
	// pass the `len(pending)>0` guard before insertion → 2nd snapshot of an
	// already-mutated state = anti-lock-out broken.
	pendingMu.Lock()
	if len(pending) > 0 || pendingReserving {
		pendingMu.Unlock()
		return nil, fmt.Errorf("another firewall change is pending confirmation; wait or confirm it first")
	}
	pendingReserving = true
	pendingMu.Unlock()

	// From here on we MUST release the reservation on every error path.
	ufwEnabled := ufwIsActive()
	snapshotFile, err := snapshotIptables(requestID)
	if err != nil {
		pendingMu.Lock()
		pendingReserving = false
		pendingMu.Unlock()
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
	pendingReserving = false
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
		"enabled": enabled,
		"raw":     outStr,
		"pending": pendingList,
		"error":   err != nil,
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
		// Revert immediately on failure
		HandleConfirm(reqID) // releases the pending (timer + snapshot)
		return nil, fmt.Errorf("ufw allow failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":             true,
		"request_id":          reqID,
		"watchdog_expires_in": int(watchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":              string(output),
	}, nil
}

// ===================== firewall.deny =====================

type FirewallDenyAction struct{}

func (a *FirewallDenyAction) ID() string         { return "firewall.deny" }
func (a *FirewallDenyAction) Capability() string { return "firewall" }
func (a *FirewallDenyAction) Validate(params map[string]interface{}) error {
	// same validation as allow
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
		"applied":             true,
		"request_id":          reqID,
		"watchdog_expires_in": int(watchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":              string(output),
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
	// `ufw --force delete N` to avoid asking for interactive confirmation
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "--force", "delete", strconv.Itoa(n))
	output, err := cmd.CombinedOutput()
	if err != nil {
		HandleConfirm(reqID)
		return nil, fmt.Errorf("ufw delete failed: %w: %s", err, string(output))
	}
	return map[string]interface{}{
		"applied":             true,
		"request_id":          reqID,
		"watchdog_expires_in": int(watchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":              string(output),
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
		"applied":             true,
		"request_id":          reqID,
		"watchdog_expires_in": int(watchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":              string(output),
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
		"applied":             true,
		"request_id":          reqID,
		"watchdog_expires_in": int(watchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
		"output":              string(output),
	}, nil
}

// ===================== firewall.apply_policy =====================
// Firewall assistant: allows a list of detected ports then enables ufw
// (deny incoming by default). ONE single watchdog'd operation (iptables snapshot
// + 60s revert). Anti-lock-out (defense in depth): the SSH port(s) the machine is
// currently listening on are ALWAYS added to the allow list AGENT-SIDE (not only
// in the UI), and the watchdog restores everything if access is lost.

type FirewallApplyPolicyAction struct{}

func (a *FirewallApplyPolicyAction) ID() string         { return "firewall.apply_policy" }
func (a *FirewallApplyPolicyAction) Capability() string { return "firewall" }

func (a *FirewallApplyPolicyAction) Validate(params map[string]interface{}) error {
	raw, ok := params["allow"].([]interface{})
	if !ok || len(raw) == 0 {
		return fmt.Errorf("required parameter 'allow' missing (port list, e.g. [\"22/tcp\",\"80/tcp\"])")
	}
	if len(raw) > 100 {
		return fmt.Errorf("too many rules (max 100)")
	}
	for _, item := range raw {
		s, ok := item.(string)
		if !ok || !firewallPortRegex.MatchString(s) {
			return fmt.Errorf("invalid allow entry %q (expected: port or port/tcp|udp)", item)
		}
	}
	return nil
}

func (a *FirewallApplyPolicyAction) Execute(params map[string]interface{}) (interface{}, error) {
	raw := params["allow"].([]interface{})
	allow := make([]string, 0, len(raw))
	for _, item := range raw {
		allow = append(allow, item.(string))
	}

	// Anti-lock-out enforced AGENT-SIDE: guarantee the SSH port(s) are allowed,
	// even if the caller omitted them (e.g. a direct API call bypassing the UI).
	allow = ensureAllowed(allow, sshAllowPorts())

	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("firewall-%d", time.Now().UnixNano())
	}

	pr, err := registerPendingRevert(reqID)
	if err != nil {
		return nil, err
	}

	// fail: immediate revert from the snapshot then releases the pending.
	fail := func(format string, args ...interface{}) (interface{}, error) {
		_ = restoreFromSnapshot(pr.SnapshotFile, pr.UfwEnabled)
		HandleConfirm(reqID)
		return nil, fmt.Errorf(format, args...)
	}

	// 1. Allow the ports BEFORE enabling (rules are in place before enforcement).
	for _, port := range allow {
		cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "allow", port)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fail("ufw allow %s failed: %w: %s", port, err, string(out))
		}
	}

	// 2. Enable ufw (deny incoming by default on a standard activation).
	cmd := exec.Command("/usr/bin/sudo", "/usr/sbin/ufw", "--force", "enable")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fail("ufw enable failed: %w: %s", err, string(out))
	}

	return map[string]interface{}{
		"applied":             true,
		"request_id":          reqID,
		"allowed":             allow,
		"watchdog_expires_in": int(watchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(watchdogDuration).Format(time.RFC3339),
	}, nil
}

// ensureAllowed appends every token of `extra` not already in `base`
// (order-preserving, de-duplicated). Pure helper — the anti-lock-out merge is
// unit-tested here.
func ensureAllowed(base, extra []string) []string {
	present := make(map[string]bool, len(base))
	for _, p := range base {
		present[p] = true
	}
	for _, p := range extra {
		if !present[p] {
			base = append(base, p)
			present[p] = true
		}
	}
	return base
}

// sshAllowPorts returns the ufw "allow" tokens for the SSH port(s) the machine is
// currently listening on (reuses the `ss` detection of network.listening_services).
// Falls back to "22/tcp" when detection is unavailable, so firewall.apply_policy
// can NEVER lock SSH out — the anti-lock-out golden rule is enforced here, not only
// in the UI. Ports are re-validated against firewallPortRegex before being emitted.
func sshAllowPorts() []string {
	set := map[string]bool{}
	if bin := ssPath(); bin != "" {
		out, err := exec.Command("sudo", "-n", bin, "-Htlnp").Output()
		if err != nil {
			out, _ = exec.Command(bin, "-Htln").Output()
		}
		for _, s := range parseSsListening(string(out)) {
			tok := s.Port + "/tcp"
			if s.IsSSH && firewallPortRegex.MatchString(tok) {
				set[tok] = true
			}
		}
	}
	if len(set) == 0 {
		set["22/tcp"] = true // safe default: never leave SSH unprotected
	}
	ports := make([]string, 0, len(set))
	for p := range set {
		ports = append(ports, p)
	}
	return ports
}
