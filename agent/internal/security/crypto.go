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
	"io"
	"math/big"
	"strings"
	"time"

	"golang.org/x/crypto/hkdf"
)

// GenerateECDSAKeypair génère une paire de clés ECDSA P-256
func GenerateECDSAKeypair() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// MarshalPublicKeyPEM convertit une clé publique en PEM
func MarshalPublicKeyPEM(pub *ecdsa.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", fmt.Errorf("failed to marshal public key: %w", err)
	}
	block := &pem.Block{Type: "PUBLIC KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

// MarshalPrivateKeyPEM convertit une clé privée en PEM
func MarshalPrivateKeyPEM(priv *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", fmt.Errorf("failed to marshal private key: %w", err)
	}
	block := &pem.Block{Type: "PRIVATE KEY", Bytes: der}
	return string(pem.EncodeToMemory(block)), nil
}

// ParsePublicKeyPEM parse une clé publique PEM
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

// ParsePrivateKeyPEM parse une clé privée PEM
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

// SignPayload signe un payload avec ECDSA SHA-256
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

// VerifySignature vérifie une signature ECDSA
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

// DeriveSharedSecret dérive un secret partagé via ECDH
func DeriveSharedSecret(privateKey *ecdsa.PrivateKey, peerPublicKey *ecdsa.PublicKey) ([]byte, error) {
	// ECDH: multiply peer's public point by our private scalar
	x, _ := peerPublicKey.Curve.ScalarMult(peerPublicKey.X, peerPublicKey.Y, privateKey.D.Bytes())
	if x == nil {
		return nil, fmt.Errorf("ECDH failed")
	}

	// Derive 256-bit key using HKDF
	// Note: pas de salt pour correspondre au backend (crypto.hkdfSync avec salt="")
	hkdfReader := hkdf.New(sha256.New, x.Bytes(), nil, []byte("nexus-shared-secret"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdfReader, key); err != nil {
		return nil, fmt.Errorf("HKDF failed: %w", err)
	}
	return key, nil
}

// DecryptAES déchiffre avec AES-256-GCM
// Supporte 2 formats :
//   - Go:   nonce:ciphertext+tag (2 parties)
//   - Node: iv:authTag:ciphertext (3 parties)
func DecryptAES(encrypted string, key []byte) (string, error) {
	parts := strings.Split(encrypted, ":")

	var nonce, ciphertext []byte
	var err error

	switch len(parts) {
	case 2:
		// Format Go : nonce:ciphertext (tag inclus dans ciphertext par GCM)
		nonce, err = base64.StdEncoding.DecodeString(parts[0])
		if err != nil {
			return "", fmt.Errorf("decode nonce: %w", err)
		}
		ciphertext, err = base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return "", fmt.Errorf("decode ciphertext: %w", err)
		}

	case 3:
		// Format Node.js : iv:authTag:ciphertext
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
		// GCM attend ciphertext+tag concaténés
		ciphertext = append(ct, authTag...)

	default:
		return "", fmt.Errorf("invalid encrypted format: %d parts", len(parts))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	// Supporter nonce de 12 bytes (Go standard) et 16 bytes (Node.js IV_LENGTH)
	var gcm cipher.AEAD
	if len(nonce) == 12 {
		gcm, err = cipher.NewGCM(block)
	} else {
		gcm, err = cipher.NewGCMWithNonceSize(block, len(nonce))
	}
	if err != nil {
		return "", err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// GenerateNonce génère un nonce aléatoire hex
func GenerateNonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return fmt.Sprintf("%x", b)
}

// BuildSignaturePayload construit le payload à signer
func BuildSignaturePayload(msgType, requestID, machineID, timestamp, nonce, payload string) string {
	return fmt.Sprintf("%s:%s:%s:%s:%s:%s", msgType, requestID, machineID, timestamp, nonce, payload)
}

// IsTimestampValid vérifie que le timestamp est dans la fenêtre acceptable
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
