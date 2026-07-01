package security

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/hkdf"
)

// Keystore manages on-disk key storage
type Keystore struct {
	basePath   string
	privateKey *ecdsa.PrivateKey
	publicKey  *ecdsa.PublicKey
}

func NewKeystore(basePath string) *Keystore {
	return &Keystore{basePath: basePath}
}

// NEXUS-CRYPTO-001 — at-rest encryption of agent.key (SOFTWARE machine-binding).
//
// Variables (not const) to allow injection in tests; prod values are fixed. The
// wrapping key is derived from machine-id (non-secret) + a per-install salt. The
// `wrappingKey()` seam is ISOLATED to graft a TPM backend later (DEF-1) without
// rewriting GenerateAndSave/Load.
//
// WHAT THIS PROTECTS:
//   - copy of the agent.key file ALONE (without machine-id or salt) → unusable;
//   - reuse on ANOTHER machine (different machine-id) → failure;
//   - live non-root/non-agent process → closed by AGENT-002 (cap dropped).
//
// WHAT THIS DOES NOT PROTECT (documented limitation — README/fix):
//   - FULL DISK SNAPSHOT / BACKUP (PBS, Proxmox): machine-id AND the salt travel
//     with it → the wrapping key is re-derivable. ONLY THE TPM (DEF-1) closes this case.
//   - live compromise of the nexus-agent user or root: has all the inputs.
var (
	machineIDPath = "/etc/machine-id"
	keySaltPath   = "/etc/nexus/agent-keysalt" // root:nexus-agent 0640, scope-split from KEY_DIR
)

// wrappingKey derives the AES-256 wrapping key: HKDF(machine-id, salt, info).
// Salt kept separate from KEY_DIR (config vs state): an exfil scoped to a single
// dir misses one half. Fail-closed: machine-id/salt missing or too short → error.
func wrappingKey() ([]byte, error) {
	mid, err := os.ReadFile(machineIDPath)
	if err != nil {
		return nil, fmt.Errorf("read machine-id: %w", err)
	}
	mid = bytes.TrimSpace(mid)
	if len(mid) == 0 {
		return nil, fmt.Errorf("empty machine-id (%s)", machineIDPath)
	}
	salt, err := os.ReadFile(keySaltPath)
	if err != nil {
		return nil, fmt.Errorf("read key salt %s: %w", keySaltPath, err)
	}
	salt = bytes.TrimSpace(salt)
	if len(salt) < 16 {
		return nil, fmt.Errorf("key salt %s too short", keySaltPath)
	}
	r := hkdf.New(sha256.New, mid, salt, []byte("nexus-keystore-wrap"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("HKDF wrap key: %w", err)
	}
	return key, nil
}

// sealAtRest encrypts IN MEMORY (AES-256-GCM, "nonce:ciphertext" format). The
// plaintext is never written to disk by the caller.
func sealAtRest(plaintext []byte) (string, error) {
	wk, err := wrappingKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(wk)
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

// openAtRest decrypts (GCM tag verified by DecryptAES, raises if invalid).
func openAtRest(blob string) ([]byte, error) {
	wk, err := wrappingKey()
	if err != nil {
		return nil, err
	}
	pt, err := DecryptAES(strings.TrimSpace(blob), wk)
	if err != nil {
		return nil, fmt.Errorf("decrypt agent key at rest: %w", err)
	}
	return []byte(pt), nil
}

// HasKeypair checks whether a keypair exists
func (ks *Keystore) HasKeypair() bool {
	privPath := filepath.Join(ks.basePath, "agent.key")
	_, err := os.Stat(privPath)
	return err == nil
}

// GenerateAndSave generates a new keypair and saves it
func (ks *Keystore) GenerateAndSave() error {
	if err := os.MkdirAll(ks.basePath, 0700); err != nil {
		return fmt.Errorf("failed to create key directory: %w", err)
	}

	priv, err := GenerateECDSAKeypair()
	if err != nil {
		return fmt.Errorf("failed to generate keypair: %w", err)
	}

	privPEM, err := MarshalPrivateKeyPEM(priv)
	if err != nil {
		return err
	}
	pubPEM, err := MarshalPublicKeyPEM(&priv.PublicKey)
	if err != nil {
		return err
	}

	privPath := filepath.Join(ks.basePath, "agent.key")
	pubPath := filepath.Join(ks.basePath, "agent.pub")

	// NEXUS-CRYPTO-001: encrypt IN MEMORY before any WriteFile. The private key's
	// cleartext PEM NEVER touches the disk — the only write is the ciphertext.
	sealed, err := sealAtRest([]byte(privPEM))
	if err != nil {
		return fmt.Errorf("seal agent key at rest: %w", err)
	}
	if err := os.WriteFile(privPath, []byte(sealed), 0600); err != nil {
		return fmt.Errorf("failed to write private key: %w", err)
	}
	// The PUBLIC key stays in cleartext (it is public).
	if err := os.WriteFile(pubPath, []byte(pubPEM), 0644); err != nil {
		return fmt.Errorf("failed to write public key: %w", err)
	}

	ks.privateKey = priv
	ks.publicKey = &priv.PublicKey

	return nil
}

// Load loads the keys from disk (decrypts agent.key at rest).
func (ks *Keystore) Load() error {
	privPath := filepath.Join(ks.basePath, "agent.key")
	blob, err := os.ReadFile(privPath)
	if err != nil {
		return fmt.Errorf("failed to read private key: %w", err)
	}

	privPEM, legacy, err := decryptOrDetectLegacy(string(blob))
	if err != nil {
		return err
	}

	priv, err := ParsePrivateKeyPEM(privPEM)
	if err != nil {
		return err
	}
	ks.privateKey = priv
	ks.publicKey = &priv.PublicKey

	// Auto-migration: an agent from before CRYPTO-001 has a CLEARTEXT key. We
	// re-encrypt it IN PLACE, without leaving any cleartext behind (encrypted temp
	// + atomic rename; no .bak, no cleartext temp file). Non-fatal: the key is
	// already loaded.
	if legacy {
		if err := rewriteEncryptedInPlace(privPath, privPEM); err != nil {
			log.Printf("[Keystore] at-rest migration warning (key loaded, re-encryption to be retried at next boot): %v", err)
		} else {
			log.Printf("[Keystore] agent.key migrated to at-rest encryption (CRYPTO-001)")
		}
	}
	return nil
}

// decryptOrDetectLegacy: if the content is a CLEARTEXT PEM (legacy pre-CRYPTO-001),
// returns it as-is with legacy=true; otherwise decrypts the at-rest blob.
func decryptOrDetectLegacy(blob string) (pem string, legacy bool, err error) {
	if strings.Contains(blob, "-----BEGIN") {
		return blob, true, nil
	}
	pt, err := openAtRest(blob)
	if err != nil {
		return "", false, err
	}
	return string(pt), false, nil
}

// rewriteEncryptedInPlace re-encrypts the PEM and atomically replaces the file.
// The temporary file contains the CIPHERTEXT (never the cleartext); the rename
// overwrites the old file (no .bak). No cleartext remains.
func rewriteEncryptedInPlace(privPath, plaintextPEM string) error {
	sealed, err := sealAtRest([]byte(plaintextPEM))
	if err != nil {
		return err
	}
	tmp := privPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(sealed), 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, privPath); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// GetPrivateKey returns the private key
func (ks *Keystore) GetPrivateKey() *ecdsa.PrivateKey {
	return ks.privateKey
}

// GetPublicKeyPEM returns the public key in PEM
func (ks *Keystore) GetPublicKeyPEM() (string, error) {
	if ks.publicKey == nil {
		return "", fmt.Errorf("no public key loaded")
	}
	return MarshalPublicKeyPEM(ks.publicKey)
}

// Protocol v2 (CRYPTO-004): the AES session key is NO LONGER persisted — it is
// derived on each connection via the ephemeral ECDHE handshake (forward secrecy).
// We keep on disk only the long-term identity (agent.key) and a successful-
// enrollment marker (the former "dual" role of shared.secret as enrollment proof
// is taken over by this marker, with no channel secret at rest).

// MarkEnrolled writes the successful-enrollment marker (purged on --reenroll,
// which wipes $KEY_DIR clean).
func (ks *Keystore) MarkEnrolled() error {
	path := filepath.Join(ks.basePath, "enrolled")
	return os.WriteFile(path, []byte("v2\n"), 0600)
}

// IsEnrolled indicates whether the agent has already completed an enrollment (identity present).
func (ks *Keystore) IsEnrolled() bool {
	path := filepath.Join(ks.basePath, "enrolled")
	_, err := os.Stat(path)
	return err == nil
}
