package security

import (
	"crypto/ecdh"
	"crypto/rand"
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

// CRYPTO-004 : la clé de session est dérivée d'un ECDHE X25519 éphémère. Les deux
// parties (agent ea, backend eb) doivent dériver le MÊME K ; un machine_id
// différent doit donner un K différent (domain-separation HKDF).
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
		t.Fatal("clé de session non symétrique entre les deux parties éphémères")
	}
	kc, _ := deriveSessionKey(sa, "m2")
	if string(ka) == string(kc) {
		t.Fatal("domain-separation par machine_id absente (HKDF info)")
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

	// 6. Version de protocole non supportée (v1 / champ v absent) → rejeté
	badVersion := build()
	badVersion.V = 1
	if err := VerifyServerMessage(badVersion, &server.PublicKey); err == nil {
		t.Fatal("message à version de protocole non supportée accepté")
	}
}
