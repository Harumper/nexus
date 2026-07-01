package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// Curve asymmetry (intentional, two distinct roles):
//   - X25519  → channel SESSION keys (ECDHE handshake, forward secrecy).
//   - P-256   → bootstrap SEAL + IDENTITY. Constrained by the PINNED server key
//               (server-public-key.pem, ECDSA P-256) already deployed at install:
//               we can only seal to that key's curve.

// sealHKDF derives the seal's AES-256 key from a P-256 ECDH secret, with
// domain-separation by machine_id (info="nexus-enroll:<id>", distinct from the
// channel "nexus-session:<id>"). Empty salt to match the backend crypto.hkdfSync.
func sealHKDF(ecdhSecret []byte, machineID string) ([]byte, error) {
	r := hkdf.New(sha256.New, ecdhSecret, nil, []byte("nexus-enroll:"+machineID))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("HKDF seal key: %w", err)
	}
	return key, nil
}

// sealEncryptAESGCM encrypts in AES-256-GCM in the "nonce:ciphertext" format
// (base64), identical to the channel → the backend reuses decryptAES to open it.
func sealEncryptAESGCM(plaintext, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nil, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(nonce) + ":" + base64.StdEncoding.EncodeToString(ct), nil
}

// SealToServer seals `plaintext` to the PINNED server key (ECIES P-256):
// ephemeral ECDH → pinned key via crypto/ecdh (not the deprecated low-level API of
// crypto/elliptic, removed from the project), HKDF "nexus-enroll:<id>", AES-256-GCM.
// Returns the ephemeral public key (PEM
// SPKI) and the sealed blob. Token confidentiality + agent pubkey integrity:
// an on-path attacker without the server private key can neither read nor modify.
//
// The ephemeral private key (eph) lives ONLY in this function: never stored in a
// struct, never logged, never returned. It goes out of scope on return.
func SealToServer(plaintext []byte, pinnedServerKey *ecdsa.PublicKey, machineID string) (ephPubPEM string, sealed string, err error) {
	serverECDH, err := pinnedServerKey.ECDH() // *ecdsa.PublicKey → *ecdh.PublicKey (P-256)
	if err != nil {
		return "", "", fmt.Errorf("pinned key to ECDH: %w", err)
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("ephemeral keygen: %w", err)
	}
	secret, err := eph.ECDH(serverECDH)
	if err != nil {
		return "", "", fmt.Errorf("ECDH: %w", err)
	}
	kSeal, err := sealHKDF(secret, machineID)
	if err != nil {
		return "", "", err
	}
	sealedBlob, err := sealEncryptAESGCM(plaintext, kSeal)
	if err != nil {
		return "", "", fmt.Errorf("seal encrypt: %w", err)
	}
	der, err := x509.MarshalPKIXPublicKey(eph.PublicKey())
	if err != nil {
		return "", "", fmt.Errorf("marshal ephemeral pub: %w", err)
	}
	ephPubPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return ephPubPEM, sealedBlob, nil
	// eph (the seal's ephemeral private key) goes out of scope → discarded.
}
