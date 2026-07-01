package actions

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

func init() {
	Register(&NetworkStatusAction{})
	Register(&NetworkInterfacesAction{})
	Register(&NetplanGetAction{})
	Register(&NetplanApplyAction{})
}

const (
	netplanWatchdogDuration = 120 * time.Second
	netplanDir              = "/etc/netplan"
	netplanSnapshotPrefix   = "netplan-snapshot-"
	netplanTargetFilename   = "99-nexus.yaml" // file managed by Nexus (does not touch the others)
)

// Regex YAML filename
var yamlFilenameRegex = regexp.MustCompile(`^[a-zA-Z0-9._-]+\.yaml$`)

// PendingNetplan is a netplan change awaiting confirmation.
type PendingNetplan struct {
	RequestID   string
	SnapshotDir string
	Timer       *time.Timer
	CreatedAt   time.Time
}

var (
	netplanMu        sync.Mutex
	pendingNetplan   = map[string]*PendingNetplan{}
	netplanReserving bool // in-flight reservation (closes the TOCTOU window)
)

// HandleNetplanConfirm cancels the pending revert.
func HandleNetplanConfirm(requestID string) {
	netplanMu.Lock()
	defer netplanMu.Unlock()
	p, ok := pendingNetplan[requestID]
	if !ok {
		return
	}
	p.Timer.Stop()
	os.RemoveAll(p.SnapshotDir)
	delete(pendingNetplan, requestID)
	log.Printf("[Netplan] Change confirmed for request_id=%s, snapshot discarded", requestID)
}

// RecoverPendingNetplan is called at agent startup.
func RecoverPendingNetplan() {
	entries, err := os.ReadDir(snapshotDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !strings.HasPrefix(e.Name(), netplanSnapshotPrefix) {
			continue
		}
		snapDir := filepath.Join(snapshotDir, e.Name())
		log.Printf("[Netplan] Recovering pending snapshot %s — reverting", snapDir)
		if err := restoreNetplanFromSnapshot(snapDir); err != nil {
			log.Printf("[Netplan] Revert failed: %v", err)
		}
		os.RemoveAll(snapDir)
	}
}

// snapshotNetplan copies all .yaml files from /etc/netplan into a tempdir.
func snapshotNetplan(requestID string) (string, error) {
	os.MkdirAll(snapshotDir, 0700)
	snapDir := filepath.Join(snapshotDir, netplanSnapshotPrefix+requestID)
	if err := os.MkdirAll(snapDir, 0700); err != nil {
		return "", err
	}

	entries, err := os.ReadDir(netplanDir)
	if err != nil {
		return "", fmt.Errorf("read netplan dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		src := filepath.Join(netplanDir, e.Name())
		dst := filepath.Join(snapDir, e.Name())
		if err := copyFile(src, dst); err != nil {
			return "", fmt.Errorf("snapshot %s: %w", src, err)
		}
	}
	return snapDir, nil
}

// restoreNetplanFromSnapshot replaces /etc/netplan/*.yaml with the snapshot and applies.
func restoreNetplanFromSnapshot(snapDir string) error {
	// 1. Remove all current .yaml files
	currentEntries, _ := os.ReadDir(netplanDir)
	for _, e := range currentEntries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".yaml") {
			if err := sudoRun("/bin/rm", "-f", filepath.Join(netplanDir, e.Name())); err != nil {
				log.Printf("[Netplan] failed to remove %s: %v", e.Name(), err)
			}
		}
	}
	// 2. Restore from snapshot
	snapEntries, _ := os.ReadDir(snapDir)
	for _, e := range snapEntries {
		if e.IsDir() {
			continue
		}
		src := filepath.Join(snapDir, e.Name())
		dst := filepath.Join(netplanDir, e.Name())
		// AGENT-008: privhelper (src realpath under staging + dst validated under
		// /etc/netplan, *.yaml, no traversal).
		if err := sudoRun(nexusAgentBin, "privhelper", "install-netplan", src, dst); err != nil {
			return fmt.Errorf("install %s: %w", dst, err)
		}
	}
	// 3. Apply
	cmd := exec.Command("sudo", "-n", "/usr/sbin/netplan", "apply")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("netplan apply: %w: %s", err, string(out))
	}
	return nil
}

// registerPendingNetplan snapshot + arms the 120s timer.
func registerPendingNetplan(requestID string) (*PendingNetplan, error) {
	netplanMu.Lock()
	if len(pendingNetplan) > 0 || netplanReserving {
		netplanMu.Unlock()
		return nil, fmt.Errorf("another netplan change is pending confirmation")
	}
	netplanReserving = true
	netplanMu.Unlock()

	snapDir, err := snapshotNetplan(requestID)
	if err != nil {
		netplanMu.Lock()
		netplanReserving = false
		netplanMu.Unlock()
		return nil, err
	}

	p := &PendingNetplan{
		RequestID:   requestID,
		SnapshotDir: snapDir,
		CreatedAt:   time.Now(),
	}
	p.Timer = time.AfterFunc(netplanWatchdogDuration, func() {
		netplanMu.Lock()
		defer netplanMu.Unlock()
		if _, still := pendingNetplan[requestID]; !still {
			return
		}
		log.Printf("[Netplan] Watchdog expired for request_id=%s — reverting", requestID)
		if err := restoreNetplanFromSnapshot(p.SnapshotDir); err != nil {
			log.Printf("[Netplan] Revert failed: %v", err)
		}
		os.RemoveAll(p.SnapshotDir)
		delete(pendingNetplan, requestID)
	})

	netplanMu.Lock()
	pendingNetplan[requestID] = p
	netplanReserving = false
	netplanMu.Unlock()
	return p, nil
}

// ═══════════════════════════════════════════════════════════════
// network.status: ip -j addr, routes, DNS, netplan pending info
// ═══════════════════════════════════════════════════════════════

type NetworkStatusAction struct{}

func (a *NetworkStatusAction) ID() string                              { return "network.status" }
func (a *NetworkStatusAction) Capability() string                      { return "monitoring" }
func (a *NetworkStatusAction) Validate(_ map[string]interface{}) error { return nil }

func (a *NetworkStatusAction) Execute(_ map[string]interface{}) (interface{}, error) {
	addrRaw, addrErr := exec.Command("/usr/sbin/ip", "-j", "addr").Output()
	routeRaw, routeErr := exec.Command("/usr/sbin/ip", "-j", "route").Output()

	// If both commands fail, surface a real error rather than
	// returning null fields (which crash the .map on the frontend side).
	if addrErr != nil && routeErr != nil {
		return nil, fmt.Errorf("ip addr/route unavailable: %v / %v", addrErr, routeErr)
	}

	// Non-nil initialized slices: a JSON {"addresses":[],"routes":[]} rather
	// than null, even if a command fails or returns empty.
	addrs := []interface{}{}
	routes := []interface{}{}
	_ = json.Unmarshal(addrRaw, &addrs)
	_ = json.Unmarshal(routeRaw, &routes)

	// Pending netplan snapshots
	netplanMu.Lock()
	pendings := make([]map[string]interface{}, 0, len(pendingNetplan))
	for _, p := range pendingNetplan {
		pendings = append(pendings, map[string]interface{}{
			"request_id":         p.RequestID,
			"created_at":         p.CreatedAt.Format(time.RFC3339),
			"expires_in_seconds": int(netplanWatchdogDuration.Seconds() - time.Since(p.CreatedAt).Seconds()),
		})
	}
	netplanMu.Unlock()

	return map[string]interface{}{
		"addresses": addrs,
		"routes":    routes,
		"pending":   pendings,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// network.interfaces: simple list of interfaces with state
// ═══════════════════════════════════════════════════════════════

type NetworkInterfacesAction struct{}

func (a *NetworkInterfacesAction) ID() string                              { return "network.interfaces" }
func (a *NetworkInterfacesAction) Capability() string                      { return "monitoring" }
func (a *NetworkInterfacesAction) Validate(_ map[string]interface{}) error { return nil }

func (a *NetworkInterfacesAction) Execute(_ map[string]interface{}) (interface{}, error) {
	out, err := exec.Command("/usr/sbin/ip", "-j", "link").Output()
	if err != nil {
		return nil, fmt.Errorf("ip link: %w", err)
	}
	var links []interface{}
	if err := json.Unmarshal(out, &links); err != nil {
		return nil, fmt.Errorf("parse ip link json: %w", err)
	}
	return map[string]interface{}{"interfaces": links}, nil
}

// ═══════════════════════════════════════════════════════════════
// netplan.get: reads all .yaml files from /etc/netplan
// ═══════════════════════════════════════════════════════════════

type NetplanGetAction struct{}

func (a *NetplanGetAction) ID() string                              { return "netplan.get" }
func (a *NetplanGetAction) Capability() string                      { return "monitoring" }
func (a *NetplanGetAction) Validate(_ map[string]interface{}) error { return nil }

func (a *NetplanGetAction) Execute(_ map[string]interface{}) (interface{}, error) {
	entries, err := os.ReadDir(netplanDir)
	if err != nil {
		return nil, fmt.Errorf("read netplan dir: %w", err)
	}
	files := []map[string]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		// Use sudo cat because some netplan files are 600
		out, err := exec.Command("sudo", "-n", "/bin/cat", filepath.Join(netplanDir, e.Name())).Output()
		if err != nil {
			continue
		}
		files = append(files, map[string]string{
			"filename": e.Name(),
			"content":  string(out),
		})
	}
	return map[string]interface{}{
		"dir":              netplanDir,
		"files":            files,
		"target_file":      netplanTargetFilename,
		"managed_by_nexus": netplanTargetFilename,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// netplan.apply: writes 99-nexus.yaml, snapshot, apply, watchdog
// ═══════════════════════════════════════════════════════════════

type NetplanApplyAction struct{}

func (a *NetplanApplyAction) ID() string         { return "netplan.apply" }
func (a *NetplanApplyAction) Capability() string { return "network" }

func (a *NetplanApplyAction) Validate(params map[string]interface{}) error {
	content, ok := params["content"].(string)
	if !ok || content == "" {
		return fmt.Errorf("required parameter 'content' missing")
	}
	if len(content) > 65536 {
		return fmt.Errorf("content too large (max 64KB)")
	}
	// Basic validation: must start with "network:" and not contain null bytes
	if strings.Contains(content, "\x00") {
		return fmt.Errorf("content contains null bytes")
	}
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "network:") {
		return fmt.Errorf("content must start with 'network:' (YAML netplan root)")
	}
	return nil
}

func (a *NetplanApplyAction) Execute(params map[string]interface{}) (interface{}, error) {
	content := params["content"].(string)
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	reqID, _ := params["request_id"].(string)
	if reqID == "" {
		reqID = fmt.Sprintf("netplan-%d", time.Now().UnixNano())
	}

	// 1. Snapshot
	pr, err := registerPendingNetplan(reqID)
	if err != nil {
		return nil, err
	}

	// 2. Write the new file into a tempfile then sudo install
	tmp, err := os.CreateTemp(snapshotDir, "netplan-new-*.yaml")
	if err != nil {
		HandleNetplanConfirm(reqID)
		return nil, fmt.Errorf("create temp: %w", err)
	}
	tmp.WriteString(content)
	tmp.Close()
	defer os.Remove(tmp.Name())

	targetPath := filepath.Join(netplanDir, netplanTargetFilename)
	if err := sudoRun(nexusAgentBin, "privhelper", "install-netplan", tmp.Name(), targetPath); err != nil {
		HandleNetplanConfirm(reqID)
		return nil, fmt.Errorf("install yaml: %w", err)
	}

	// 3. Apply
	cmd := exec.Command("sudo", "-n", "/usr/sbin/netplan", "apply")
	if out, err := cmd.CombinedOutput(); err != nil {
		// Apply failed -> immediate revert
		HandleNetplanConfirm(reqID)
		restoreNetplanFromSnapshot(pr.SnapshotDir)
		return nil, fmt.Errorf("netplan apply failed: %w: %s", err, string(out))
	}

	return map[string]interface{}{
		"applied":             true,
		"request_id":          reqID,
		"target_file":         targetPath,
		"watchdog_expires_in": int(netplanWatchdogDuration.Seconds()),
		"watchdog_expires_at": pr.CreatedAt.Add(netplanWatchdogDuration).Format(time.RFC3339),
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

func copyFile(src, dst string) error {
	sf, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sf.Close()
	df, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer df.Close()
	_, err = io.Copy(df, sf)
	return err
}

// Placeholder to avoid unused import just in case
var _ = yamlFilenameRegex
