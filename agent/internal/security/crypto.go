package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// GenerateECDSAKeypair generates an ECDSA P-256 keypair
func GenerateECDSAKeypair() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// MarshalPublicKeyPEM converts a public key to PEM
func MarshalPublicKeyPEM(pub *ecdsa.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", fmt.Errorf("failed to marshal public key: %w", err)
	}
	block := &pem.Block{Type: "PUBLIC KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

// MarshalPrivateKeyPEM converts a private key to PEM
func MarshalPrivateKeyPEM(priv *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", fmt.Errorf("failed to marshal private key: %w", err)
	}
	block := &pem.Block{Type: "PRIVATE KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

// ParsePublicKeyPEM parses a PEM public key
func ParsePublicKeyPEM(pemStr string) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse public key: %w", err)
	}
	ecdsaPub, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("not an ECDSA public key")
	}
	return ecdsaPub, nil
}

// ParsePrivateKeyPEM parses a PEM private key
func ParsePrivateKeyPEM(pemStr string) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}
	ecdsaKey, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("not an ECDSA private key")
	}
	return ecdsaKey, nil
}

// SignPayload signs a payload with ECDSA SHA-256
func SignPayload(payload string, privateKey *ecdsa.PrivateKey) (string, error) {
	hash := sha256.Sum256([]byte(payload))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, hash[:])
	if err != nil {
		return "", fmt.Errorf("failed to sign: %w", err)
	}
	// Encode r and s as base64
	rBytes := r.Bytes()
	sBytes := s.Bytes()
	// Pad to 32 bytes each (P-256)
	sig := make([]byte, 64)
	copy(sig[32-len(rBytes):32], rBytes)
	copy(sig[64-len(sBytes):64], sBytes)
	return base64.StdEncoding.EncodeToString(sig), nil
}

// VerifySignature verifies an ECDSA signature
func VerifySignature(payload, signature string, publicKey *ecdsa.PublicKey) bool {
	sigBytes, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(sigBytes) != 64 {
		return false
	}
	r := new(big.Int).SetBytes(sigBytes[:32])
	s := new(big.Int).SetBytes(sigBytes[32:])
	hash := sha256.Sum256([]byte(payload))
	return ecdsa.Verify(publicKey, hash[:], r, s)
}

// DecryptAES decrypts with AES-256-GCM
// Supports 2 formats:
//   - Go:   nonce:ciphertext+tag (2 parts)
//   - Node: iv:authTag:ciphertext (3 parts)
func DecryptAES(encrypted string, key []byte) (string, error) {
	parts := strings.Split(encrypted, ":")

	var nonce, ciphertext []byte
	var err error

	switch len(parts) {
	case 2:
		// Go format: nonce:ciphertext (tag included in ciphertext by GCM)
		nonce, err = base64.StdEncoding.DecodeString(parts[0])
		if err != nil {
			return "", fmt.Errorf("decode nonce: %w", err)
		}
		ciphertext, err = base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return "", fmt.Errorf("decode ciphertext: %w", err)
		}

	case 3:
		// Node.js format: iv:authTag:ciphertext
		nonce, err = base64.StdEncoding.DecodeString(parts[0])
		if err != nil {
			return "", fmt.Errorf("decode iv: %w", err)
		}
		authTag, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return "", fmt.Errorf("decode authTag: %w", err)
		}
		ct, err := base64.StdEncoding.DecodeString(parts[2])
		if err != nil {
			return "", fmt.Errorf("decode ciphertext: %w", err)
		}
		// GCM expects ciphertext+tag concatenated
		ciphertext = append(ct, authTag...)

	default:
		return "", fmt.Errorf("invalid encrypted format: %d parts", len(parts))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	// NEXUS-CRYPTO-006 — canonical format: 12-byte (96-bit) GCM nonce ONLY.
	// We no longer accept an arbitrary nonce length taken from the blob (deriving
	// the GCM size from the blob turned a primitive into a parser tunable by the
	// attacker and made the J0/GHASH derivation vary). A length ≠ 12 is rejected
	// outright.
	if len(nonce) != 12 {
		return "", fmt.Errorf("invalid GCM nonce length %d (expected 12)", len(nonce))
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// GenerateNonce generates a random hex nonce
func GenerateNonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return fmt.Sprintf("%x", b)
}

// ProtocolVersion is the channel protocol version verified on the agent side.
// Must stay in sync with transport.ProtocolVersion and the backend.
const ProtocolVersion = 2

// BuildSignaturePayload builds the payload to sign. The version is bound AT THE
// HEAD of the signed payload: an attacker cannot downgrade the protocol without
// breaking the signature.
func BuildSignaturePayload(version int, msgType, requestID, machineID, timestamp, nonce, payload string) string {
	return fmt.Sprintf("%d:%s:%s:%s:%s:%s:%s", version, msgType, requestID, machineID, timestamp, nonce, payload)
}

// BuildEnrollmentProofPayload — NEXUS-ENROLLMENT-002. Canonical, domain-separated
// payload that the agent signs as its enrollment proof. Binding the proof to the
// enrollment token + nonce + timestamp (not just the static machineID) makes it
// fresh and non-replayable. The backend MUST rebuild this byte-for-byte
// (enrollment.ts buildEnrollmentProofPayload) to verify.
func BuildEnrollmentProofPayload(machineID, enrollmentToken, nonce, timestamp string) string {
	return fmt.Sprintf("nexus-enroll-proof:v2:%s:%s:%s:%s", machineID, enrollmentToken, nonce, timestamp)
}

// IsTimestampValid checks that the timestamp is within the acceptable window
func IsTimestampValid(timestamp string, maxSkew time.Duration) bool {
	t, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		return false
	}
	diff := time.Since(t)
	if diff < 0 {
		diff = -diff
	}
	return diff <= maxSkew
}
