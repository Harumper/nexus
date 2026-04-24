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
	netplanTargetFilename   = "99-nexus.yaml" // fichier gere par Nexus (ne touche pas aux autres)
)

// Regex YAML filename
var yamlFilenameRegex = regexp.MustCompile(`^[a-zA-Z0-9._-]+\.yaml$`)

// PendingNetplan est une modification netplan en attente de confirmation.
type PendingNetplan struct {
	RequestID    string
	SnapshotDir  string
	Timer        *time.Timer
	CreatedAt    time.Time
}

var (
	netplanMu      sync.Mutex
	pendingNetplan = map[string]*PendingNetplan{}
)

// HandleNetplanConfirm annule le revert pending.
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

// RecoverPendingNetplan est appele au demarrage de l'agent.
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

// snapshotNetplan copie tous les fichiers .yaml de /etc/netplan dans un tempdir.
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

// restoreNetplanFromSnapshot remplace /etc/netplan/*.yaml par le snapshot et apply.
func restoreNetplanFromSnapshot(snapDir string) error {
	// 1. Supprimer tous les .yaml actuels
	currentEntries, _ := os.ReadDir(netplanDir)
	for _, e := range currentEntries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".yaml") {
			if err := sudoRun("/bin/rm", "-f", filepath.Join(netplanDir, e.Name())); err != nil {
				log.Printf("[Netplan] failed to remove %s: %v", e.Name(), err)
			}
		}
	}
	// 2. Restaurer depuis snapshot
	snapEntries, _ := os.ReadDir(snapDir)
	for _, e := range snapEntries {
		if e.IsDir() {
			continue
		}
		src := filepath.Join(snapDir, e.Name())
		dst := filepath.Join(netplanDir, e.Name())
		if err := sudoRun("/usr/bin/install", "-m", "600", "-o", "root", "-g", "root", src, dst); err != nil {
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

// registerPendingNetplan snapshot + arme le timer 120s.
func registerPendingNetplan(requestID string) (*PendingNetplan, error) {
	netplanMu.Lock()
	if len(pendingNetplan) > 0 {
		netplanMu.Unlock()
		return nil, fmt.Errorf("another netplan change is pending confirmation")
	}
	netplanMu.Unlock()

	snapDir, err := snapshotNetplan(requestID)
	if err != nil {
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
	netplanMu.Unlock()
	return p, nil
}

// ═══════════════════════════════════════════════════════════════
// network.status : ip -j addr, routes, DNS, netplan pending info
// ═══════════════════════════════════════════════════════════════

type NetworkStatusAction struct{}

func (a *NetworkStatusAction) ID() string                                 { return "network.status" }
func (a *NetworkStatusAction) Capability() string                         { return "monitoring" }
func (a *NetworkStatusAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *NetworkStatusAction) Execute(_ map[string]interface{}) (interface{}, error) {
	addrRaw, _ := exec.Command("/usr/sbin/ip", "-j", "addr").Output()
	routeRaw, _ := exec.Command("/usr/sbin/ip", "-j", "route").Output()

	var addrs, routes []interface{}
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
// network.interfaces : liste simple des interfaces avec etat
// ═══════════════════════════════════════════════════════════════

type NetworkInterfacesAction struct{}

func (a *NetworkInterfacesAction) ID() string                                 { return "network.interfaces" }
func (a *NetworkInterfacesAction) Capability() string                         { return "monitoring" }
func (a *NetworkInterfacesAction) Validate(_ map[string]interface{}) error    { return nil }

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
// netplan.get : lit tous les .yaml de /etc/netplan
// ═══════════════════════════════════════════════════════════════

type NetplanGetAction struct{}

func (a *NetplanGetAction) ID() string                                 { return "netplan.get" }
func (a *NetplanGetAction) Capability() string                         { return "monitoring" }
func (a *NetplanGetAction) Validate(_ map[string]interface{}) error    { return nil }

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
		// Utilise sudo cat car certains fichiers netplan sont 600
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
		"dir":            netplanDir,
		"files":          files,
		"target_file":    netplanTargetFilename,
		"managed_by_nexus": netplanTargetFilename,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// netplan.apply : ecrit 99-nexus.yaml, snapshot, apply, watchdog
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
	// Validation basique : doit commencer par "network:" et ne pas contenir de null bytes
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

	// 2. Ecrire le nouveau fichier dans un tempfile puis sudo install
	tmp, err := os.CreateTemp(snapshotDir, "netplan-new-*.yaml")
	if err != nil {
		HandleNetplanConfirm(reqID)
		return nil, fmt.Errorf("create temp: %w", err)
	}
	tmp.WriteString(content)
	tmp.Close()
	defer os.Remove(tmp.Name())

	targetPath := filepath.Join(netplanDir, netplanTargetFilename)
	if err := sudoRun("/usr/bin/install", "-m", "600", "-o", "root", "-g", "root", tmp.Name(), targetPath); err != nil {
		HandleNetplanConfirm(reqID)
		return nil, fmt.Errorf("install yaml: %w", err)
	}

	// 3. Apply
	cmd := exec.Command("sudo", "-n", "/usr/sbin/netplan", "apply")
	if out, err := cmd.CombinedOutput(); err != nil {
		// Apply a echoue -> revert immediat
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

// Placeholder pour eviter unused import si jamais
var _ = yamlFilenameRegex
