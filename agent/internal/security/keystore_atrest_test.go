package security

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// NEXUS-CRYPTO-001 — real behavior of the at-rest encryption of agent.key:
// round-trip, encrypted format (no cleartext PEM on disk), legacy auto-migration
// with no residual cleartext. The machine-id/salt paths are injected (test vars).

func setupAtRest(t *testing.T) (basePath string) {
	t.Helper()
	dir := t.TempDir()
	// fake machine-id + salt, injected via the package vars.
	mid := filepath.Join(dir, "machine-id")
	salt := filepath.Join(dir, "agent-keysalt")
	if err := os.WriteFile(mid, []byte("0123456789abcdef0123456789abcdef\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(salt, []byte("dGVzdC1zYWx0LTMyLWJ5dGVzLWZvci1ja3J5cHRvMDE=\n"), 0640); err != nil {
		t.Fatal(err)
	}
	oldMid, oldSalt := machineIDPath, keySaltPath
	machineIDPath, keySaltPath = mid, salt
	t.Cleanup(func() { machineIDPath, keySaltPath = oldMid, oldSalt })
	return filepath.Join(dir, "keys")
}

func TestKeyAtRest_RoundTripAndNoPlaintextOnDisk(t *testing.T) {
	base := setupAtRest(t)
	ks := NewKeystore(base)
	if err := ks.GenerateAndSave(); err != nil {
		t.Fatalf("GenerateAndSave: %v", err)
	}
	// The file on disk must NOT be a cleartext PEM.
	raw, err := os.ReadFile(filepath.Join(base, "agent.key"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "-----BEGIN") {
		t.Fatal("agent.key written in CLEARTEXT on disk (PEM detected)")
	}
	// Round-trip: reloading from a fresh keystore must give the same key.
	pubBefore, _ := ks.GetPublicKeyPEM()
	ks2 := NewKeystore(base)
	if err := ks2.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	pubAfter, _ := ks2.GetPublicKeyPEM()
	if pubBefore != pubAfter || pubAfter == "" {
		t.Fatal("reloaded key ≠ generated key")
	}
}

func TestKeyAtRest_WrongMachineContextFails(t *testing.T) {
	base := setupAtRest(t)
	ks := NewKeystore(base)
	if err := ks.GenerateAndSave(); err != nil {
		t.Fatal(err)
	}
	// Simulate another machine: different salt → decryption fails.
	if err := os.WriteFile(keySaltPath, []byte("ZGlmZmVyZW50LXNhbHQtb24tYW5vdGhlci1ob3N0LTAx\n"), 0640); err != nil {
		t.Fatal(err)
	}
	ks2 := NewKeystore(base)
	if err := ks2.Load(); err == nil {
		t.Fatal("key decrypted with a wrong machine context (different salt) — should fail")
	}
}

func TestKeyAtRest_LegacyMigrationLeavesNoCleartext(t *testing.T) {
	base := setupAtRest(t)
	if err := os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	// Write a LEGACY cleartext key (pre-CRYPTO-001 state).
	priv, _ := GenerateECDSAKeypair()
	pem, _ := MarshalPrivateKeyPEM(priv)
	privPath := filepath.Join(base, "agent.key")
	if err := os.WriteFile(privPath, []byte(pem), 0600); err != nil {
		t.Fatal(err)
	}

	ks := NewKeystore(base)
	if err := ks.Load(); err != nil {
		t.Fatalf("Load (migration): %v", err)
	}
	// After migration: the file must no longer be cleartext.
	raw, _ := os.ReadFile(privPath)
	if strings.Contains(string(raw), "-----BEGIN") {
		t.Fatal("after migration, agent.key is still CLEARTEXT")
	}
	// NO cleartext residue: no .bak, no .tmp.
	entries, _ := os.ReadDir(base)
	for _, e := range entries {
		n := e.Name()
		if strings.HasSuffix(n, ".bak") || strings.HasSuffix(n, ".tmp") {
			t.Fatalf("migration residue found: %s", n)
		}
	}
	// The migrated key must still reload.
	ks2 := NewKeystore(base)
	if err := ks2.Load(); err != nil {
		t.Fatalf("Load after migration: %v", err)
	}
}
