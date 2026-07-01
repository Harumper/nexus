package security

import (
	"crypto/ecdh"
	"crypto/rand"
	"testing"
	"time"
)

// Behavioral tests of the agent crypto: ECDSA signature, ECDH derivation,
// PEM, timestamp window and above all VerifyServerMessage (signature + anti-replay).
// Previously UNCOVERED area even though it is at the heart of the channel security.

func TestSignVerifyRoundTrip(t *testing.T) {
	priv, err := GenerateECDSAKeypair()
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	payload := "hello-nexus"
	sig, err := SignPayload(payload, priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if !VerifySignature(payload, sig, &priv.PublicKey) {
		t.Fatal("valid signature rejected")
	}
	// Tampered payload → reject
	if VerifySignature(payload+"x", sig, &priv.PublicKey) {
		t.Fatal("tampered payload accepted")
	}
	// Wrong key → reject
	other, _ := GenerateECDSAKeypair()
	if VerifySignature(payload, sig, &other.PublicKey) {
		t.Fatal("signature accepted with a wrong key")
	}
}

func TestPublicKeyPEMRoundTrip(t *testing.T) {
	priv, _ := GenerateECDSAKeypair()
	pemStr, err := MarshalPublicKeyPEM(&priv.PublicKey)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	parsed, err := ParsePublicKeyPEM(pemStr)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// The reparsed key must validate a signature from the original key.
	sig, _ := SignPayload("x", priv)
	if !VerifySignature("x", sig, parsed) {
		t.Fatal("reparsed public key inconsistent")
	}
}

// CRYPTO-004: the session key is derived from an ephemeral X25519 ECDHE. Both
// parties (agent ea, backend eb) must derive the SAME K; a different machine_id
// must give a different K (HKDF domain-separation).
func TestSessionKeyDerivationSymmetry(t *testing.T) {
	ea, _ := ecdh.X25519().GenerateKey(rand.Reader)
	eb, _ := ecdh.X25519().GenerateKey(rand.Reader)
	sa, err := ea.ECDH(eb.PublicKey())
	if err != nil {
		t.Fatalf("ECDH a: %v", err)
	}
	sb, err := eb.ECDH(ea.PublicKey())
	if err != nil {
		t.Fatalf("ECDH b: %v", err)
	}
	ka, err := deriveSessionKey(sa, "m1")
	if err != nil {
		t.Fatalf("deriveSessionKey a: %v", err)
	}
	kb, err := deriveSessionKey(sb, "m1")
	if err != nil {
		t.Fatalf("deriveSessionKey b: %v", err)
	}
	if len(ka) != 32 || string(ka) != string(kb) {
		t.Fatal("session key not symmetric between the two ephemeral parties")
	}
	kc, _ := deriveSessionKey(sa, "m2")
	if string(ka) == string(kc) {
		t.Fatal("domain-separation by machine_id absent (HKDF info)")
	}
}

func TestIsTimestampValid(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	if !IsTimestampValid(now, 5*time.Minute) {
		t.Fatal("current timestamp rejected")
	}
	old := time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	if IsTimestampValid(old, 5*time.Minute) {
		t.Fatal("10min-old timestamp accepted (5min window)")
	}
	if IsTimestampValid("not-a-date", 5*time.Minute) {
		t.Fatal("invalid timestamp accepted")
	}
}

func TestVerifyServerMessage(t *testing.T) {
	server, _ := GenerateECDSAKeypair()

	build := func() VerifyServerMessageInput {
		msg := VerifyServerMessageInput{
			V:         ProtocolVersion,
			Type:      "action.confirm",
			RequestID: "req_test",
			MachineID: "machine-1",
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Nonce:     GenerateNonce(),
			Payload:   "encrypted-blob",
		}
		sigPayload := BuildSignaturePayload(msg.V, msg.Type, msg.RequestID, msg.MachineID, msg.Timestamp, msg.Nonce, msg.Payload)
		sig, err := SignPayload(sigPayload, server)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		msg.Signature = sig
		return msg
	}

	// 1. Valid message → accepted
	ok := build()
	if err := VerifyServerMessage(ok, &server.PublicKey); err != nil {
		t.Fatalf("valid message rejected: %v", err)
	}

	// 2. Replay of the SAME message (same nonce) → rejected
	if err := VerifyServerMessage(ok, &server.PublicKey); err == nil {
		t.Fatal("replay (duplicate nonce) accepted")
	}

	// 3. Invalid signature (payload tampered after signature) → rejected
	tampered := build()
	tampered.Payload = "tampered"
	if err := VerifyServerMessage(tampered, &server.PublicKey); err == nil {
		t.Fatal("message with invalid signature accepted")
	}

	// 4. Wrong server key (pinning) → rejected
	other, _ := GenerateECDSAKeypair()
	if err := VerifyServerMessage(build(), &other.PublicKey); err == nil {
		t.Fatal("message accepted with a wrong server key (pinning broken)")
	}

	// 5. Timestamp out of window → rejected
	stale := build()
	stale.Timestamp = time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	if err := VerifyServerMessage(stale, &server.PublicKey); err == nil {
		t.Fatal("message with stale timestamp accepted")
	}

	// 6. Unsupported protocol version (v1 / v field absent) → rejected
	badVersion := build()
	badVersion.V = 1
	if err := VerifyServerMessage(badVersion, &server.PublicKey); err == nil {
		t.Fatal("message with unsupported protocol version accepted")
	}
}
