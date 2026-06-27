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

// Asymétrie de courbes (volontaire, deux rôles distincts) :
//   - X25519  → clés de SESSION du canal (handshake ECDHE, forward secrecy).
//   - P-256   → SEAL du bootstrap + IDENTITÉ. Contraint par la clé serveur PINNÉE
//               (server-public-key.pem, ECDSA P-256) déjà déployée à l'install :
//               on ne peut sceller que vers la courbe de cette clé.

// sealHKDF dérive la clé AES-256 du seal depuis un secret ECDH P-256, avec
// domain-separation par machine_id (info="nexus-enroll:<id>", distinct du canal
// "nexus-session:<id>"). Salt vide pour correspondre au backend crypto.hkdfSync.
func sealHKDF(ecdhSecret []byte, machineID string) ([]byte, error) {
	r := hkdf.New(sha256.New, ecdhSecret, nil, []byte("nexus-enroll:"+machineID))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("HKDF seal key: %w", err)
	}
	return key, nil
}

// sealEncryptAESGCM chiffre en AES-256-GCM au format "nonce:ciphertext" (base64),
// identique au canal → le backend réutilise decryptAES pour ouvrir.
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

// SealToServer scelle `plaintext` vers la clé serveur PINNÉE (ECIES P-256) :
// ECDH éphémère → clé pinnée via crypto/ecdh (et non l'API bas-niveau dépréciée de
// crypto/elliptic, retirée du projet), HKDF "nexus-enroll:<id>", AES-256-GCM.
// Retourne la clé publique éphémère (PEM
// SPKI) et le blob scellé. Confidentialité du token + intégrité de la pubkey agent
// : un attaquant on-path sans la clé privée serveur ne peut ni lire ni modifier.
//
// La clé privée éphémère (eph) vit UNIQUEMENT dans cette fonction : jamais stockée
// dans une struct, jamais loggée, jamais retournée. Elle sort de portée au retour.
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
	// eph (clé privée éphémère du seal) sort de portée → jetée.
}
