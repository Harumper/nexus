package actions

import (
	"strings"
	"testing"
)

func TestValidateUserName(t *testing.T) {
	cases := []struct {
		name    string
		input   interface{}
		wantErr bool
	}{
		// Valid POSIX names
		{"alice", "alice", false},
		{"bob_dev", "bob_dev", false},
		{"_systemd", "_systemd", false},
		{"user-2", "user-2", false},
		{"a", "a", false},
		{"max length 32", strings.Repeat("a", 32), false},

		// Invalid
		{"empty", "", true},
		{"missing param", nil, true},
		{"starts with digit", "1user", true},
		{"starts with dash", "-user", true},
		{"uppercase", "Alice", true},
		{"contains space", "alice bob", true},
		{"contains slash", "../etc/passwd", true},
		{"contains semicolon", "alice;rm", true},
		{"contains @", "alice@host", true},
		{"too long 33", strings.Repeat("a", 33), true},
		{"shell injection $", "alice$x", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			params := map[string]interface{}{}
			if tc.input != nil {
				params["username"] = tc.input
			}
			err := validateUserName(params)
			if (err != nil) != tc.wantErr {
				t.Errorf("wantErr=%v, got err=%v", tc.wantErr, err)
			}
		})
	}
}

func TestUserDeleteValidateRefusesProtected(t *testing.T) {
	a := &UserDeleteAction{}
	for _, name := range []string{"root", "nexus-agent"} {
		t.Run(name, func(t *testing.T) {
			err := a.Validate(map[string]interface{}{"username": name})
			if err == nil || !strings.Contains(err.Error(), "protected") {
				t.Errorf("expected protected error for %s, got: %v", name, err)
			}
		})
	}
}

func TestSshKeyAddValidate(t *testing.T) {
	a := &SshKeyAddAction{}
	validKey := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8yV9TLqJgz8Ji4kKlMnOpQrStUvWxYzAbCdEfGhIjK alice@host"

	cases := []struct {
		name    string
		params  map[string]interface{}
		wantErr bool
	}{
		{"missing username", map[string]interface{}{"key": validKey}, true},
		{"missing key", map[string]interface{}{"username": "alice"}, true},
		{"empty key", map[string]interface{}{"username": "alice", "key": ""}, true},
		{"invalid key type", map[string]interface{}{"username": "alice", "key": "ssh-fake AAAAB3 alice"}, true},
		{"key too short", map[string]interface{}{"username": "alice", "key": "ssh-rsa AAAA short"}, true},
		{"key too long", map[string]interface{}{"username": "alice", "key": "ssh-rsa " + strings.Repeat("A", 9000) + " comment"}, true},
		{"valid ed25519", map[string]interface{}{"username": "alice", "key": validKey}, false},
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

func TestSshKeyRemoveValidate(t *testing.T) {
	a := &SshKeyRemoveAction{}

	cases := []struct {
		name    string
		params  map[string]interface{}
		wantErr bool
	}{
		{"missing fingerprint", map[string]interface{}{"username": "alice"}, true},
		{"empty fingerprint", map[string]interface{}{"username": "alice", "fingerprint": ""}, true},
		{"invalid format - no SHA256 prefix", map[string]interface{}{"username": "alice", "fingerprint": "abcdef123"}, true},
		{"invalid format - too short", map[string]interface{}{"username": "alice", "fingerprint": "SHA256:abc"}, true},
		{"valid SHA256 fingerprint", map[string]interface{}{"username": "alice", "fingerprint": "SHA256:abcdefghij1234567890ABCDEFGHIJ"}, false},
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

func TestIsValidSshKeyLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"ed25519 valid", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8yV9TLqJgz8Ji4kKlMnOpQrStUvWxYzAbCdEfGhIjK comment", true},
		{"rsa valid no comment", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", true},
		{"ecdsa nistp256", "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY admin", true},
		{"unknown type", "ssh-fake AAAAB3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx alice", false},
		{"invalid base64", "ssh-rsa AAAA===invalid===chars--here", false},
		{"too short", "ssh-rsa AAAA short", false},
		{"missing key part", "ssh-rsa", false},
		{"empty", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isValidSshKeyLine(tc.line); got != tc.want {
				t.Errorf("got %v, want %v for line %q", got, tc.want, tc.line)
			}
		})
	}
}

func TestUserUpdateSudoValidate(t *testing.T) {
	a := &UserUpdateSudoAction{}

	if err := a.Validate(map[string]interface{}{"username": "root", "sudo": true}); err == nil {
		t.Error("expected protected error for root")
	}

	if err := a.Validate(map[string]interface{}{"username": "alice"}); err == nil {
		t.Error("expected error when 'sudo' boolean missing")
	}

	if err := a.Validate(map[string]interface{}{"username": "alice", "sudo": "yes"}); err == nil {
		t.Error("expected error when 'sudo' is not a boolean")
	}

	if err := a.Validate(map[string]interface{}{"username": "alice", "sudo": true}); err != nil {
		t.Errorf("unexpected error on valid input: %v", err)
	}
}
