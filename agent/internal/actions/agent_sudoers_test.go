package actions

import (
	"regexp"
	"testing"
)

func TestAgentSudoersCheckActionMetadata(t *testing.T) {
	a := &AgentSudoersCheckAction{}
	if a.ID() != "agent.sudoers_check" {
		t.Errorf("ID() = %q, want %q", a.ID(), "agent.sudoers_check")
	}
	if a.Capability() != "monitoring" {
		t.Errorf("Capability() = %q, want %q", a.Capability(), "monitoring")
	}
	// Validate accepts any param (read-only, no user input)
	if err := a.Validate(map[string]interface{}{}); err != nil {
		t.Errorf("Validate({}) = %v, want nil", err)
	}
	if err := a.Validate(map[string]interface{}{"unused": "anything"}); err != nil {
		t.Errorf("Validate({unused}) = %v, want nil", err)
	}
}

func TestGetSudoersHashFormat(t *testing.T) {
	// GetSudoersHash returns either "" (sudo failure / file missing)
	// or a 64-char hex SHA256. Any other value is a bug.
	hash := GetSudoersHash()
	if hash == "" {
		t.Skip("sudoers file unreadable (expected in test env without sudo)")
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(hash) {
		t.Errorf("GetSudoersHash() = %q, expected lowercase hex 64 chars", hash)
	}
}

func TestComputeSudoersHashIdempotent(t *testing.T) {
	// Two successive calls must return the same hash: the sudoers file
	// is not supposed to change during execution. If an attacker modifies
	// the file between two calls, the hashes will differ — but that's the
	// point of drift detection and not a bug here.
	h1 := computeSudoersHash()
	h2 := computeSudoersHash()
	if h1 != h2 {
		t.Errorf("hash mismatch between two calls: %q vs %q", h1, h2)
	}
}
