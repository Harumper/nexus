package actions

import (
	"strings"
	"testing"
)

func TestNetplanApplyValidate(t *testing.T) {
	a := &NetplanApplyAction{}

	cases := []struct {
		name    string
		params  map[string]interface{}
		wantErr bool
	}{
		{"missing content", map[string]interface{}{}, true},
		{"empty content", map[string]interface{}{"content": ""}, true},
		{"non-string content", map[string]interface{}{"content": 123}, true},
		{"too large > 64KB", map[string]interface{}{"content": "network:\n" + strings.Repeat("a", 65540)}, true},
		{"null byte injection", map[string]interface{}{"content": "network:\n  version: 2\n\x00malicious"}, true},
		{"no network: prefix", map[string]interface{}{"content": "ethernets:\n  eth0:\n    dhcp4: true"}, true},
		{"valid minimal", map[string]interface{}{"content": "network:\n  version: 2"}, false},
		{"valid full", map[string]interface{}{"content": "network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true"}, false},
		{"valid with leading whitespace", map[string]interface{}{"content": "  \nnetwork:\n  version: 2"}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := a.Validate(tc.params)
			if (err != nil) != tc.wantErr {
				t.Errorf("wantErr=%v, got err=%v", tc.wantErr, err)
			}
		})
	}
}

func TestYamlFilenameRegex(t *testing.T) {
	cases := []struct {
		filename string
		valid    bool
	}{
		{"99-nexus.yaml", true},
		{"01-network-manager-all.yaml", true},
		{"my_config.yaml", true},
		{"a.yaml", true},

		{"config.yml", false},    // .yml not .yaml
		{"../etc/passwd", false}, // path traversal
		{"foo.yaml.bak", false},  // double extension
		{"foo bar.yaml", false},  // space
		{"foo;rm.yaml", false},   // semicolon
		{".yaml", false},         // no name
		{"", false},
	}

	for _, tc := range cases {
		t.Run(tc.filename, func(t *testing.T) {
			got := yamlFilenameRegex.MatchString(tc.filename)
			if got != tc.valid {
				t.Errorf("regex.MatchString(%q) = %v, want %v", tc.filename, got, tc.valid)
			}
		})
	}
}

func TestHandleNetplanConfirmUnknownIDIsSafe(t *testing.T) {
	// Like HandleConfirm on the firewall side: a confirm on an unknown ID must
	// not panic, just log and return.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("HandleNetplanConfirm panicked on unknown ID: %v", r)
		}
	}()
	HandleNetplanConfirm("nonexistent-netplan-12345")
}

func TestNetplanActionsMetadata(t *testing.T) {
	// Quick check that the ID/Capability are consistent — a drift between
	// these strings and READ_ONLY_ACTIONS (backend) or the sudoers causes
	// silent bugs.
	cases := []struct {
		action interface {
			ID() string
			Capability() string
		}
		wantID  string
		wantCap string
	}{
		{&NetworkStatusAction{}, "network.status", "monitoring"},
		{&NetworkInterfacesAction{}, "network.interfaces", "monitoring"},
		{&NetplanGetAction{}, "netplan.get", "monitoring"},
		{&NetplanApplyAction{}, "netplan.apply", "network"},
	}
	for _, tc := range cases {
		if got := tc.action.ID(); got != tc.wantID {
			t.Errorf("ID() = %q, want %q", got, tc.wantID)
		}
		if got := tc.action.Capability(); got != tc.wantCap {
			t.Errorf("Capability() for %s = %q, want %q", tc.wantID, got, tc.wantCap)
		}
	}
}
