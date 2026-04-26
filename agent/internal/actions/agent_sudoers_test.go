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
	// Validate accepte n'importe quel param (lecture seule, pas d'input user)
	if err := a.Validate(map[string]interface{}{}); err != nil {
		t.Errorf("Validate({}) = %v, want nil", err)
	}
	if err := a.Validate(map[string]interface{}{"unused": "anything"}); err != nil {
		t.Errorf("Validate({unused}) = %v, want nil", err)
	}
}

func TestGetSudoersHashFormat(t *testing.T) {
	// GetSudoersHash retourne soit "" (sudo echec / fichier absent)
	// soit un SHA256 hex de 64 chars. Toute autre valeur est un bug.
	hash := GetSudoersHash()
	if hash == "" {
		t.Skip("sudoers file unreadable (expected in test env without sudo)")
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(hash) {
		t.Errorf("GetSudoersHash() = %q, expected lowercase hex 64 chars", hash)
	}
}

func TestComputeSudoersHashIdempotent(t *testing.T) {
	// Deux appels successifs doivent retourner le meme hash : le fichier
	// sudoers n'est pas suppose changer pendant l'execution. Si un attacker
	// modifie le fichier entre deux appels, les hashes différeront —
	// mais c'est le but du drift detection et pas un bug ici.
	h1 := computeSudoersHash()
	h2 := computeSudoersHash()
	if h1 != h2 {
		t.Errorf("hash mismatch entre deux appels: %q vs %q", h1, h2)
	}
}
