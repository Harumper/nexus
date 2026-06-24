package actions

import "testing"

// Échantillon réaliste de /var/log/lynis-report.dat (format plat key=value).
const sampleLynisReport = `# Lynis Report
report_version_major=1
lynis_version=3.1.2
report_datetime_start=2025-06-24 10:00:00
hardening_index=67
warning[]=SSH-7408|sshd configuration uses weak setting|-|-
suggestion[]=SSH-7408|Consider hardening SSH configuration|-|text:Harden it|
suggestion[]=FIRE-4513|Check iptables rules for unused entries|-|-
firewall_installed=1
firewall_active=1
firewall_empty_ruleset=0
installed_package[]=openssh-server
`

func TestParseLynisReport(t *testing.T) {
	out := parseLynisReport([]byte(sampleLynisReport))

	if got := out["hardening_index"].(int); got != 67 {
		t.Errorf("hardening_index = %d, want 67", got)
	}
	if got := out["lynis_version"].(string); got != "3.1.2" {
		t.Errorf("lynis_version = %q, want 3.1.2", got)
	}
	if out["firewall_active"].(bool) != true {
		t.Errorf("firewall_active = false, want true")
	}
	if out["firewall_empty_ruleset"].(bool) != false {
		t.Errorf("firewall_empty_ruleset = true, want false")
	}

	warnings := out["warnings"].([]lynisItem)
	if len(warnings) != 1 {
		t.Fatalf("warnings len = %d, want 1", len(warnings))
	}
	if warnings[0].ID != "SSH-7408" {
		t.Errorf("warning[0].ID = %q, want SSH-7408", warnings[0].ID)
	}
	if warnings[0].Text != "sshd configuration uses weak setting" {
		t.Errorf("warning[0].Text = %q", warnings[0].Text)
	}

	suggestions := out["suggestions"].([]lynisItem)
	if len(suggestions) != 2 {
		t.Fatalf("suggestions len = %d, want 2", len(suggestions))
	}
	if suggestions[0].ID != "SSH-7408" || suggestions[0].Text != "Consider hardening SSH configuration" {
		t.Errorf("suggestion[0] = %+v", suggestions[0])
	}
	if out["suggestion_count"].(int) != 2 {
		t.Errorf("suggestion_count = %v, want 2", out["suggestion_count"])
	}
}

func TestParseLynisReportEmpty(t *testing.T) {
	out := parseLynisReport([]byte(""))
	if out["hardening_index"].(int) != -1 {
		t.Errorf("empty report: hardening_index = %v, want -1", out["hardening_index"])
	}
	if len(out["warnings"].([]lynisItem)) != 0 {
		t.Errorf("empty report should have 0 warnings")
	}
}
