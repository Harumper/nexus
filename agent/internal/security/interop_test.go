package security

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Cross-language Go↔Node interop safety net (TEST-DEBT-001, permanent partial net).
//
// The testdata/interop-vectors.json file is produced by the REAL Go code
// (deriveSessionKey + SealToServer). Two guards consume it:
//   - here (Go)           : the Go derivation/format stays consistent with the fixture.
//   - backend (Node)      : Node derives the same K (X25519) and OPENS the Go seal
//                           (P-256). See backend/tests/e2e/interop-vectors.test.ts.
// If either side drifts, its test breaks → the Go↔Node agreement is guaranteed by
// the shared fixture. This is NOT the full e2e (TEST-DEBT-001), it's the most
// critical interop net, nearly free.

type interopVectors struct {
	X25519 struct {
		EaPub     string `json:"ea_pub"`
		EbPriv    string `json:"eb_priv"`
		EbPub     string `json:"eb_pub"`
		MachineID string `json:"machine_id"`
		KHex      string `json:"k_hex"`
	} `json:"x25519"`
	Seal struct {
		ServerPrivPEM string `json:"server_priv_pem"`
		EphPubPEM     string `json:"eph_pub_pem"`
		Sealed        string `json:"sealed"`
		MachineID     string `json:"machine_id"`
		PlaintextB64  string `json:"plaintext_b64"`
	} `json:"seal"`
}

func vectorsPath() string { return filepath.Join("testdata", "interop-vectors.json") }

// TestEmitInteropVectors regenerates the fixture on demand (tool, not run in
// CI): INTEROP_REGEN=1 go test ./internal/security/ -run TestEmitInteropVectors
func TestEmitInteropVectors(t *testing.T) {
	if os.Getenv("INTEROP_REGEN") != "1" {
		t.Skip("fixture regeneration: set INTEROP_REGEN=1")
	}
	var v interopVectors

	// X25519: deterministic vector (K = HKDF(ECDH) depends only on the keys).
	ea, _ := ecdh.X25519().GenerateKey(rand.Reader)
	eb, _ := ecdh.X25519().GenerateKey(rand.Reader)
	v.X25519.MachineID = "machine-interop-x25519"
	secret, err := ea.ECDH(eb.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	k, err := deriveSessionKey(secret, v.X25519.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	v.X25519.EaPub = base64.StdEncoding.EncodeToString(ea.PublicKey().Bytes())
	v.X25519.EbPriv = base64.StdEncoding.EncodeToString(eb.Bytes())
	v.X25519.EbPub = base64.StdEncoding.EncodeToString(eb.PublicKey().Bytes())
	v.X25519.KHex = hex.EncodeToString(k)

	// Seal P-256: produced by the REAL SealToServer (random nonce → we commit the
	// blob as-is; Node will open it, opening is deterministic).
	server, _ := GenerateECDSAKeypair()
	serverPrivPEM, _ := MarshalPrivateKeyPEM(server)
	v.Seal.MachineID = "machine-interop-seal"
	plaintext := []byte(`{"enrollment_token":"tok_interop","agent_public_key":"AGENT_PUB"}`)
	ephPubPEM, sealed, err := SealToServer(plaintext, &server.PublicKey, v.Seal.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	v.Seal.ServerPrivPEM = serverPrivPEM
	v.Seal.EphPubPEM = ephPubPEM
	v.Seal.Sealed = sealed
	v.Seal.PlaintextB64 = base64.StdEncoding.EncodeToString(plaintext)

	if err := os.MkdirAll("testdata", 0755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.MarshalIndent(&v, "", "  ")
	if err := os.WriteFile(vectorsPath(), data, 0644); err != nil {
		t.Fatal(err)
	}
}

// TestInteropVectorsGo (permanent): the Go code stays consistent with the fixture.
func TestInteropVectorsGo(t *testing.T) {
	raw, err := os.ReadFile(vectorsPath())
	if err != nil {
		t.Fatalf("fixture not found (regenerate with INTEROP_REGEN=1): %v", err)
	}
	var v interopVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}

	// X25519: Go re-derives K from (eb_priv, ea_pub) → must equal k_hex.
	eaPubBytes, _ := base64.StdEncoding.DecodeString(v.X25519.EaPub)
	ebPrivBytes, _ := base64.StdEncoding.DecodeString(v.X25519.EbPriv)
	eaPub, err := ecdh.X25519().NewPublicKey(eaPubBytes)
	if err != nil {
		t.Fatal(err)
	}
	ebPriv, err := ecdh.X25519().NewPrivateKey(ebPrivBytes)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := ebPriv.ECDH(eaPub)
	if err != nil {
		t.Fatal(err)
	}
	k, err := deriveSessionKey(secret, v.X25519.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(k) != v.X25519.KHex {
		t.Fatalf("X25519 K Go ≠ fixture: got %s want %s", hex.EncodeToString(k), v.X25519.KHex)
	}
}
