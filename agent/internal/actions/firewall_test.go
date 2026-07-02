package actions

import (
	"strings"
	"testing"
)

func TestFirewallAllowValidate(t *testing.T) {
	a := &FirewallAllowAction{}

	cases := []struct {
		name    string
		params  map[string]interface{}
		wantErr string
	}{
		{"missing rule", map[string]interface{}{}, "rule"},
		{"empty rule", map[string]interface{}{"rule": ""}, "rule"},
		{"rule too long", map[string]interface{}{"rule": strings.Repeat("a", 257)}, "too long"},
		{"semicolon injection", map[string]interface{}{"rule": "80/tcp; rm -rf /"}, "invalid character"},
		{"pipe injection", map[string]interface{}{"rule": "80/tcp | nc attacker"}, "invalid character"},
		{"backtick injection", map[string]interface{}{"rule": "80/tcp `whoami`"}, "invalid character"},
		{"dollar injection", map[string]interface{}{"rule": "80/tcp $(id)"}, "invalid character"},
		{"newline injection", map[string]interface{}{"rule": "80/tcp\nrm -rf /"}, "invalid character"},
		{"ampersand injection", map[string]interface{}{"rule": "80/tcp & evil"}, "invalid character"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := a.Validate(tc.params)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("expected error containing %q, got: %v", tc.wantErr, err)
			}
		})
	}
}

func TestFirewallAllowValidateAccepts(t *testing.T) {
	a := &FirewallAllowAction{}

	valid := []string{
		"80/tcp",
		"443/tcp",
		"22",
		"from 10.0.0.0/8 to any port 22",
		"from 192.168.1.0/24",
		"in on eth0 from any to any port 80",
		"proto tcp from any to any port 443",
	}

	for _, rule := range valid {
		t.Run(rule, func(t *testing.T) {
			if err := a.Validate(map[string]interface{}{"rule": rule}); err != nil {
				t.Errorf("expected valid, got error: %v", err)
			}
		})
	}
}

func TestFirewallDenyDelegatesValidate(t *testing.T) {
	// Deny uses the same validation as allow: verify that injection
	// rejection also works on the deny side (same code path).
	a := &FirewallDenyAction{}
	if err := a.Validate(map[string]interface{}{"rule": "80/tcp; evil"}); err == nil {
		t.Error("Deny should reject shell injection like Allow")
	}
}

func TestFirewallRuleRemoveValidate(t *testing.T) {
	a := &FirewallRuleRemoveAction{}

	cases := []struct {
		name   string
		params map[string]interface{}
		isErr  bool
	}{
		{"missing", map[string]interface{}{}, true},
		{"zero", map[string]interface{}{"number": 0}, true},
		{"negative", map[string]interface{}{"number": -1}, true},
		{"valid int 1", map[string]interface{}{"number": 1}, false},
		{"valid int 42", map[string]interface{}{"number": 42}, false},
		{"valid float (JSON)", map[string]interface{}{"number": float64(5)}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := a.Validate(tc.params)
			if (err != nil) != tc.isErr {
				t.Errorf("isErr=%v but got err=%v", tc.isErr, err)
			}
		})
	}
}

func TestHandleConfirmUnknownIDIsSafe(t *testing.T) {
	// HandleConfirm on an unknown request_id must log + return without panicking.
	// Otherwise an attacker could crash the agent by spamming forged confirms.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("HandleConfirm panicked on unknown ID: %v", r)
		}
	}()
	HandleConfirm("nonexistent-request-id-12345")
}

func TestEnsureAllowedMergesSSHWithoutDup(t *testing.T) {
	// The anti-lock-out merge: apply_policy must always end up with the SSH
	// port(s), without duplicating one the caller already provided.
	cases := []struct {
		name  string
		base  []string
		extra []string
		want  string
	}{
		{"adds missing ssh", []string{"80/tcp"}, []string{"22/tcp"}, "80/tcp,22/tcp"},
		{"no dup when present", []string{"22/tcp", "80/tcp"}, []string{"22/tcp"}, "22/tcp,80/tcp"},
		{"empty base gets ssh", []string{}, []string{"22/tcp"}, "22/tcp"},
		{"multiple ssh ports", []string{"443/tcp"}, []string{"22/tcp", "2222/tcp"}, "443/tcp,22/tcp,2222/tcp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := strings.Join(ensureAllowed(tc.base, tc.extra), ",")
			if got != tc.want {
				t.Errorf("ensureAllowed(%v,%v)=%q, want %q", tc.base, tc.extra, got, tc.want)
			}
		})
	}
}

func TestSSHAllowPortsAlwaysReturnsValidPort(t *testing.T) {
	// Even with no ss/sudo available (test container), it MUST fall back to a
	// valid, non-empty SSH token so apply_policy can never omit SSH.
	ports := sshAllowPorts()
	if len(ports) == 0 {
		t.Fatal("sshAllowPorts returned empty — SSH could be locked out")
	}
	for _, p := range ports {
		if !firewallPortRegex.MatchString(p) {
			t.Errorf("sshAllowPorts returned invalid token %q", p)
		}
	}
}
