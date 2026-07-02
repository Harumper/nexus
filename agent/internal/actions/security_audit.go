package actions

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// OnSecurityProgress streams the Lynis audit lines to the frontend
// (live console), like OnUpdateProgress for apt. Wired in main.go.
var OnSecurityProgress ProgressCallback

func init() {
	Register(&SecurityAuditAction{})
}

// ═══════════════════════════════════════════════════════════════
// security.audit: runs Lynis (hardening audit, FOSS GPLv3) and
// returns a structured result (hardening index, warnings, suggestions,
// firewall state). READ-ONLY — Lynis applies no changes.
// The finding -> remediation mapping is done on the backend/UI side (1 click).
// ═══════════════════════════════════════════════════════════════

type SecurityAuditAction struct{}

func (a *SecurityAuditAction) ID() string                              { return "security.audit" }
func (a *SecurityAuditAction) Capability() string                      { return "monitoring" }
func (a *SecurityAuditAction) Validate(_ map[string]interface{}) error { return nil }

const lynisReportPath = "/var/log/lynis-report.dat"

// Possible paths of the lynis binary depending on packaging (Debian/Ubuntu =
// /usr/sbin, EPEL/others = /usr/bin). BOTH are whitelisted in sudoers.
var lynisPaths = []string{"/usr/sbin/lynis", "/usr/bin/lynis"}

func lynisPath() string {
	for _, p := range lynisPaths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

type lynisItem struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func (a *SecurityAuditAction) Execute(_ map[string]interface{}) (interface{}, error) {
	if OnSecurityProgress != nil {
		OnSecurityProgress("Starting Lynis audit…", 2)
	}
	// NEXUS-AGENT-007 — an audit OBSERVES, it never MUTATES the audited machine.
	// security.audit no longer installs Lynis: it is a design flaw for an audit to
	// alter its subject. If Lynis is absent, we degrade cleanly with an actionable
	// message — installing it is the operator's provisioning responsibility
	// (apt/dnf install lynis), outside the agent's scope.
	installed := false // this action never installs anything
	bin := lynisPath()
	if bin == "" {
		return nil, fmt.Errorf("lynis not installed: audit unavailable. Provision it (apt install lynis / dnf install lynis) to enable the security audit — the agent does not install any package during an audit (read-only)")
	}

	// STREAMING audit: we read lynis's output line by line and push it via
	// OnSecurityProgress (live console on the UI side). --quick avoids the
	// end-of-run pause; --no-colors for clean output. Lynis always writes its
	// report to /var/log/lynis-report.dat.
	// Hard timeout (5 min): a stuck lynis must never freeze the agent nor the
	// modal indefinitely. Setpgid + Cancel kill the whole group on expiry.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sudo", "-n", bin, "audit", "system", "--quick", "--no-colors")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	stdout, pipeErr := cmd.StdoutPipe()
	if pipeErr != nil {
		return nil, fmt.Errorf("pipe lynis: %w", pipeErr)
	}
	cmd.Stderr = cmd.Stdout // combine stderr (e.g. sudo refusal) into the stream
	auditStart := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start lynis: %w", err)
	}
	lineCount := 0
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		lineCount++
		if OnSecurityProgress != nil {
			OnSecurityProgress(sc.Text(), min(5+lineCount/4, 95))
		}
	}
	// Exit code != 0 = warnings present: NON-blocking. We rely on the report.
	_ = cmd.Wait()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("Lynis audit interrupted: timeout (5 min) exceeded")
	}

	// Guardrail: if the report was not RE-written by this run (mtime earlier than
	// the launch), then lynis could not run (typically "sudo: a password is
	// required" → stale sudoers). We refuse to return the old report as if it were
	// fresh.
	if fi, statErr := os.Stat(lynisReportPath); statErr != nil || fi.ModTime().Before(auditStart) {
		return nil, fmt.Errorf("Lynis could not run (insufficient sudo rights? stale sudoers — reinstall/re-enroll the agent). No fresh report produced.")
	}

	report, err := readLynisReport()
	if err != nil {
		// The lines (including any sudo refusal) have already been streamed.
		return nil, fmt.Errorf("Lynis report unavailable: %v", err)
	}
	if OnSecurityProgress != nil {
		OnSecurityProgress("Audit complete.", 100)
	}

	parsed := parseLynisReport(report)
	parsed["lynis_installed_now"] = installed
	parsed["lynis_path"] = bin
	// State of the "1-click" remediations (drives the UI buttons).
	parsed["fail2ban_installed"] = fileExists("/usr/bin/fail2ban-client")
	parsed["fail2ban_active"] = systemctlActive("fail2ban")
	parsed["auto_updates_active"] = autoUpdatesActive()
	parsed["ssh_hardened"] = fileExists(sshdDropinPath)
	parsed["login_banner_set"] = loginBannerSet()
	parsed["core_dumps_disabled"] = coreDumpsDisabled()
	parsed["login_defs_hardened"] = loginDefsHardened()
	parsed["sysctl_network_hardened"] = networkSysctlHardened()
	return parsed, nil
}

// The report is root:root — read via sudo cat (fixed whitelisted path).
func readLynisReport() ([]byte, error) {
	if data, err := os.ReadFile(lynisReportPath); err == nil {
		return data, nil
	}
	out, err := exec.Command("sudo", "-n", "/bin/cat", lynisReportPath).CombinedOutput()
	if err != nil {
		// Surface the real cause: "No such file" (lynis did not run) vs
		// "a password is required"/"not allowed" (missing sudoers cat).
		return nil, fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return out, nil
}

// parseLynisReport parses the flat key=value format of lynis-report.dat.
// Notable fields: hardening_index, warning[]=ID|text|..., suggestion[]=...,
// firewall_active, firewall_empty_ruleset, lynis_version.
func parseLynisReport(data []byte) map[string]interface{} {
	warnings := []lynisItem{}
	suggestions := []lynisItem{}
	scalars := map[string]string{}

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		key := line[:eq]
		val := line[eq+1:]

		switch key {
		case "warning[]":
			warnings = append(warnings, splitLynisItem(val))
		case "suggestion[]":
			suggestions = append(suggestions, splitLynisItem(val))
		default:
			// We keep only the last value of scalar keys.
			if !strings.HasSuffix(key, "[]") {
				scalars[key] = val
			}
		}
	}

	hardeningIndex := -1
	if v, ok := scalars["hardening_index"]; ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			hardeningIndex = n
		}
	}

	return map[string]interface{}{
		"hardening_index":        hardeningIndex,
		"lynis_version":          scalars["lynis_version"],
		"warnings":               warnings,
		"suggestions":            suggestions,
		"warning_count":          len(warnings),
		"suggestion_count":       len(suggestions),
		"firewall_active":        scalars["firewall_active"] == "1",
		"firewall_empty_ruleset": scalars["firewall_empty_ruleset"] == "1",
		"scan_date":              scalars["report_datetime_start"],
	}
}

// A Lynis item = "TEST-ID|description|details|solution" (fields separated by |,
// often "-" when empty). We keep the ID and the first non-empty text field.
func splitLynisItem(val string) lynisItem {
	parts := strings.Split(val, "|")
	item := lynisItem{}
	if len(parts) > 0 {
		item.ID = strings.TrimSpace(parts[0])
	}
	for _, p := range parts[1:] {
		p = strings.TrimSpace(p)
		if p != "" && p != "-" {
			item.Text = p
			break
		}
	}
	return item
}
