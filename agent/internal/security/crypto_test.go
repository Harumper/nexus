package security

import (
	"testing"
	"time"
)

// Tests comportementaux de la crypto agent : signature ECDSA, dérivation ECDH,
// PEM, fenêtre timestamp et surtout VerifyServerMessage (signature + anti-replay).
// Zone précédemment NON couverte alors qu'elle est au cœur de la sécurité du canal.

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
		t.Fatal("signature valide rejetée")
	}
	// Payload altéré → rejet
	if VerifySignature(payload+"x", sig, &priv.PublicKey) {
		t.Fatal("payload altéré accepté")
	}
	// Mauvaise clé → rejet
	other, _ := GenerateECDSAKeypair()
	if VerifySignature(payload, sig, &other.PublicKey) {
		t.Fatal("signature acceptée avec une mauvaise clé")
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
	// La clé reparsée doit valider une signature de la clé d'origine.
	sig, _ := SignPayload("x", priv)
	if !VerifySignature("x", sig, parsed) {
		t.Fatal("clé publique reparsée incohérente")
	}
}

func TestDeriveSharedSecretSymmetry(t *testing.T) {
	a, _ := GenerateECDSAKeypair()
	b, _ := GenerateECDSAKeypair()
	sa, err := DeriveSharedSecret(a, &b.PublicKey)
	if err != nil {
		t.Fatalf("derive a: %v", err)
	}
	sb, err := DeriveSharedSecret(b, &a.PublicKey)
	if err != nil {
		t.Fatalf("derive b: %v", err)
	}
	if len(sa) == 0 || string(sa) != string(sb) {
		t.Fatal("ECDH non symétrique (les deux côtés doivent dériver le même secret)")
	}
}

func TestIsTimestampValid(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	if !IsTimestampValid(now, 5*time.Minute) {
		t.Fatal("timestamp courant rejeté")
	}
	old := time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	if IsTimestampValid(old, 5*time.Minute) {
		t.Fatal("timestamp vieux de 10min accepté (fenêtre 5min)")
	}
	if IsTimestampValid("pas-une-date", 5*time.Minute) {
		t.Fatal("timestamp invalide accepté")
	}
}

func TestVerifyServerMessage(t *testing.T) {
	server, _ := GenerateECDSAKeypair()

	build := func() VerifyServerMessageInput {
		msg := VerifyServerMessageInput{
			Type:      "action.confirm",
			RequestID: "req_test",
			MachineID: "machine-1",
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Nonce:     GenerateNonce(),
			Payload:   "encrypted-blob",
		}
		sigPayload := BuildSignaturePayload(msg.Type, msg.RequestID, msg.MachineID, msg.Timestamp, msg.Nonce, msg.Payload)
		sig, err := SignPayload(sigPayload, server)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		msg.Signature = sig
		return msg
	}

	// 1. Message valide → accepté
	ok := build()
	if err := VerifyServerMessage(ok, &server.PublicKey); err != nil {
		t.Fatalf("message valide rejeté: %v", err)
	}

	// 2. Rejeu du MÊME message (même nonce) → rejeté
	if err := VerifyServerMessage(ok, &server.PublicKey); err == nil {
		t.Fatal("rejeu (nonce dupliqué) accepté")
	}

	// 3. Signature invalide (payload altéré après signature) → rejeté
	tampered := build()
	tampered.Payload = "tampered"
	if err := VerifyServerMessage(tampered, &server.PublicKey); err == nil {
		t.Fatal("message à signature invalide accepté")
	}

	// 4. Mauvaise clé serveur (pinning) → rejeté
	other, _ := GenerateECDSAKeypair()
	if err := VerifyServerMessage(build(), &other.PublicKey); err == nil {
		t.Fatal("message accepté avec une mauvaise clé serveur (pinning cassé)")
	}

	// 5. Timestamp hors fenêtre → rejeté
	stale := build()
	stale.Timestamp = time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	if err := VerifyServerMessage(stale, &server.PublicKey); err == nil {
		t.Fatal("message à timestamp périmé accepté")
	}
}
