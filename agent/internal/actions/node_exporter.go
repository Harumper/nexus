package actions

import (
	"fmt"
)

func init() {
	Register(&InstallNodeExporterAction{})
	Register(&NodeExporterStatusAction{})
	Register(&UninstallNodeExporterAction{})
}

// ═══════════════════════════════════════════════════════════════
// Prometheus node-exporter — install / status / uninstall.
//
// Nexus does not store or graph long-term system metrics itself (that is
// Prometheus/Grafana). This installs the standard Debian/Ubuntu
// `prometheus-node-exporter` package (listens on :9100) so the monitoring stack
// can scrape detailed per-host system metrics. Target discovery is served by the
// backend http_sd endpoint. No third-party repo/GPG pinning is needed (unlike
// fluent-bit): the distro package is current and maintained.
//
// Security wiring reused as-is: `apt-get install/remove -y -qq *` is already
// whitelisted (NOEXEC backstop) in sudoers, and service control goes through the
// compiled privhelper `svc` (deny-list of protected units; node-exporter is not
// protected) — so this file adds NO new sudoers line and NO privhelper change.
// ═══════════════════════════════════════════════════════════════

const (
	nodeExporterBinary  = "/usr/bin/prometheus-node-exporter"
	nodeExporterService = "prometheus-node-exporter"
	nodeExporterPort    = 9100
)

func nodeExporterState() map[string]interface{} {
	return map[string]interface{}{
		"installed": fileExists(nodeExporterBinary),
		"active":    systemctlActive(nodeExporterService),
		"port":      nodeExporterPort,
	}
}

// ── monitoring.install_node_exporter (mutation) ──
type InstallNodeExporterAction struct{}

func (a *InstallNodeExporterAction) ID() string                              { return "monitoring.install_node_exporter" }
func (a *InstallNodeExporterAction) Capability() string                      { return "monitoring" }
func (a *InstallNodeExporterAction) Validate(_ map[string]interface{}) error { return nil }

func (a *InstallNodeExporterAction) Execute(_ map[string]interface{}) (interface{}, error) {
	if !fileExists(nodeExporterBinary) {
		distroID := osReleaseField("ID")
		if distroID != "ubuntu" && distroID != "debian" {
			return nil, fmt.Errorf("auto-install supports ubuntu/debian only (got ID=%q) — install prometheus-node-exporter manually", distroID)
		}
		if err := sudoRun("/usr/bin/apt-get", "update"); err != nil {
			return nil, fmt.Errorf("apt-get update: %w", err)
		}
		if err := sudoRun("/usr/bin/apt-get", "install", "-y", "-qq", "prometheus-node-exporter"); err != nil {
			return nil, fmt.Errorf("apt-get install prometheus-node-exporter: %w", err)
		}
	}
	// Ensure enabled + started (via the compiled privhelper; systemctl stays out of sudoers).
	if err := sudoRun(nexusAgentBin, "privhelper", "svc", "enable", nodeExporterService); err != nil {
		return nil, fmt.Errorf("enable %s: %w", nodeExporterService, err)
	}
	if err := sudoRun(nexusAgentBin, "privhelper", "svc", "start", nodeExporterService); err != nil {
		return nil, fmt.Errorf("start %s: %w", nodeExporterService, err)
	}
	return nodeExporterState(), nil
}

// ── monitoring.node_exporter_status (read-only) ──
type NodeExporterStatusAction struct{}

func (a *NodeExporterStatusAction) ID() string                              { return "monitoring.node_exporter_status" }
func (a *NodeExporterStatusAction) Capability() string                      { return "monitoring" }
func (a *NodeExporterStatusAction) Validate(_ map[string]interface{}) error { return nil }

func (a *NodeExporterStatusAction) Execute(_ map[string]interface{}) (interface{}, error) {
	return nodeExporterState(), nil
}

// ── monitoring.uninstall_node_exporter (mutation) ──
type UninstallNodeExporterAction struct{}

func (a *UninstallNodeExporterAction) ID() string                              { return "monitoring.uninstall_node_exporter" }
func (a *UninstallNodeExporterAction) Capability() string                      { return "monitoring" }
func (a *UninstallNodeExporterAction) Validate(_ map[string]interface{}) error { return nil }

func (a *UninstallNodeExporterAction) Execute(_ map[string]interface{}) (interface{}, error) {
	_ = sudoRun(nexusAgentBin, "privhelper", "svc", "disable", nodeExporterService)
	_ = sudoRun(nexusAgentBin, "privhelper", "svc", "stop", nodeExporterService)
	if err := sudoRun("/usr/bin/apt-get", "remove", "-y", "-qq", "prometheus-node-exporter"); err != nil {
		return nil, fmt.Errorf("apt-get remove prometheus-node-exporter: %w", err)
	}
	return map[string]interface{}{"installed": fileExists(nodeExporterBinary)}, nil
}
