package security

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// NEXUS-CRYPTO-001 — comportement réel du chiffrement au repos de agent.key :
// round-trip, format chiffré (pas de PEM clair sur disque), auto-migration legacy
// sans clair résiduel. Les chemins machine-id/sel sont injectés (vars de test).

func setupAtRest(t *testing.T) (basePath string) {
	t.Helper()
	dir := t.TempDir()
	// machine-id + sel factices, injectés via les vars de package.
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
	// Le fichier sur disque ne doit PAS être un PEM clair.
	raw, err := os.ReadFile(filepath.Join(base, "agent.key"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "-----BEGIN") {
		t.Fatal("agent.key écrit en CLAIR sur disque (PEM détecté)")
	}
	// Round-trip : recharger depuis un keystore neuf doit donner la même clé.
	pubBefore, _ := ks.GetPublicKeyPEM()
	ks2 := NewKeystore(base)
	if err := ks2.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	pubAfter, _ := ks2.GetPublicKeyPEM()
	if pubBefore != pubAfter || pubAfter == "" {
		t.Fatal("clé rechargée ≠ clé générée")
	}
}

func TestKeyAtRest_WrongMachineContextFails(t *testing.T) {
	base := setupAtRest(t)
	ks := NewKeystore(base)
	if err := ks.GenerateAndSave(); err != nil {
		t.Fatal(err)
	}
	// Simuler une autre machine : sel différent → déchiffrement échoue.
	if err := os.WriteFile(keySaltPath, []byte("ZGlmZmVyZW50LXNhbHQtb24tYW5vdGhlci1ob3N0LTAx\n"), 0640); err != nil {
		t.Fatal(err)
	}
	ks2 := NewKeystore(base)
	if err := ks2.Load(); err == nil {
		t.Fatal("clé déchiffrée avec un mauvais contexte machine (sel différent) — devrait échouer")
	}
}

func TestKeyAtRest_LegacyMigrationLeavesNoCleartext(t *testing.T) {
	base := setupAtRest(t)
	if err := os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	// Écrire une clé LEGACY en clair (état d'avant CRYPTO-001).
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
	// Après migration : le fichier ne doit plus être en clair.
	raw, _ := os.ReadFile(privPath)
	if strings.Contains(string(raw), "-----BEGIN") {
		t.Fatal("après migration, agent.key est encore en CLAIR")
	}
	// AUCUN résidu clair : pas de .bak, pas de .tmp.
	entries, _ := os.ReadDir(base)
	for _, e := range entries {
		n := e.Name()
		if strings.HasSuffix(n, ".bak") || strings.HasSuffix(n, ".tmp") {
			t.Fatalf("résidu de migration trouvé: %s", n)
		}
	}
	// La clé migrée doit toujours se recharger.
	ks2 := NewKeystore(base)
	if err := ks2.Load(); err != nil {
		t.Fatalf("Load après migration: %v", err)
	}
}
