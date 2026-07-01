package actions

import (
	"strings"
	"testing"
)

func TestValidateServiceName(t *testing.T) {
	cases := []struct {
		name    string
		input   interface{}
		wantErr bool
	}{
		// Valid systemd unit names
		{"nginx", "nginx", false},
		{"nginx.service", "nginx.service", false},
		{"docker.service", "docker.service", false},
		{"getty@tty1.service", "getty@tty1.service", false},
		{"systemd-resolved", "systemd-resolved", false},
		{"my_app.service", "my_app.service", false},

		// Invalid
		{"missing", nil, true},
		{"empty", "", true},
		{"shell injection ;", "nginx; rm -rf /", true},
		{"shell injection &&", "nginx && evil", true},
		{"shell injection $", "nginx$(whoami)", true},
		{"backtick", "`whoami`", true},
		{"slash", "../etc/shadow", true},
		{"space", "foo bar", true},
		{"newline", "foo\nbar", true},
		{"too long 129", strings.Repeat("a", 129), true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			params := map[string]interface{}{}
			if tc.input != nil {
				params["service"] = tc.input
			}
			_, err := validateServiceName(params)
			if (err != nil) != tc.wantErr {
				t.Errorf("wantErr=%v, got err=%v", tc.wantErr, err)
			}
		})
	}
}

func TestIsProtectedService(t *testing.T) {
	cases := []struct {
		name     string
		service  string
		expected bool
	}{
		{"nexus-agent bare", "nexus-agent", true},
		{"nexus-agent.service", "nexus-agent.service", true},
		{"nginx", "nginx", false},
		{"nginx.service", "nginx.service", false},
		{"nexus-agent-other", "nexus-agent-other", false},
		{"docker", "docker", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isProtectedService(tc.service); got != tc.expected {
				t.Errorf("isProtectedService(%q) = %v, want %v", tc.service, got, tc.expected)
			}
		})
	}
}

func TestServiceStopRefusesNexusAgent(t *testing.T) {
	a := &ServiceStopAction{}
	for _, name := range []string{"nexus-agent", "nexus-agent.service"} {
		t.Run(name, func(t *testing.T) {
			err := a.Validate(map[string]interface{}{"service": name})
			if err == nil {
				t.Errorf("expected protection error stopping %s, got nil", name)
			}
			if !strings.Contains(err.Error(), "protected") {
				t.Errorf("expected protected error, got: %v", err)
			}
		})
	}
}

func TestServiceRestartRefusesNexusAgent(t *testing.T) {
	a := &ServiceRestartAction{}
	for _, name := range []string{"nexus-agent", "nexus-agent.service"} {
		t.Run(name, func(t *testing.T) {
			err := a.Validate(map[string]interface{}{"service": name})
			if err == nil {
				t.Errorf("expected protection error restarting %s, got nil", name)
			}
		})
	}
}

func TestServiceStopAcceptsOthers(t *testing.T) {
	a := &ServiceStopAction{}
	for _, name := range []string{"nginx", "nginx.service", "docker", "cron"} {
		t.Run(name, func(t *testing.T) {
			if err := a.Validate(map[string]interface{}{"service": name}); err != nil {
				t.Errorf("unexpected error on %s: %v", name, err)
			}
		})
	}
}

func TestServiceStartAllowsAnyValidName(t *testing.T) {
	// start is not dangerous: no nexus-agent protection (already running)
	// but the regex validation must still block injections.
	a := &ServiceStartAction{}
	if err := a.Validate(map[string]interface{}{"service": "nexus-agent"}); err != nil {
		t.Errorf("start should allow nexus-agent (already running): %v", err)
	}
	if err := a.Validate(map[string]interface{}{"service": "evil; rm -rf /"}); err == nil {
		t.Error("start must reject shell injection")
	}
}
