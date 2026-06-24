package security

import (
	"crypto/ecdsa"
	"fmt"
	"os"
	"path/filepath"
)

// Keystore gère le stockage des clés sur disque
type Keystore struct {
	basePath   string
	privateKey *ecdsa.PrivateKey
	publicKey  *ecdsa.PublicKey
}

func NewKeystore(basePath string) *Keystore {
	return &Keystore{basePath: basePath}
}

// HasKeypair vérifie si une paire de clés existe
func (ks *Keystore) HasKeypair() bool {
	privPath := filepath.Join(ks.basePath, "agent.key")
	_, err := os.Stat(privPath)
	return err == nil
}

// GenerateAndSave génère une nouvelle paire et la sauvegarde
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

	// Sauvegarder avec permissions restrictives (0600)
	privPath := filepath.Join(ks.basePath, "agent.key")
	pubPath := filepath.Join(ks.basePath, "agent.pub")

	if err := os.WriteFile(privPath, []byte(privPEM), 0600); err != nil {
		return fmt.Errorf("failed to write private key: %w", err)
	}
	if err := os.WriteFile(pubPath, []byte(pubPEM), 0644); err != nil {
		return fmt.Errorf("failed to write public key: %w", err)
	}

	ks.privateKey = priv
	ks.publicKey = &priv.PublicKey

	return nil
}

// Load charge les clés depuis le disque
func (ks *Keystore) Load() error {
	privPath := filepath.Join(ks.basePath, "agent.key")
	privPEM, err := os.ReadFile(privPath)
	if err != nil {
		return fmt.Errorf("failed to read private key: %w", err)
	}

	priv, err := ParsePrivateKeyPEM(string(privPEM))
	if err != nil {
		return err
	}

	ks.privateKey = priv
	ks.publicKey = &priv.PublicKey

	return nil
}

// GetPrivateKey retourne la clé privée
func (ks *Keystore) GetPrivateKey() *ecdsa.PrivateKey {
	return ks.privateKey
}

// GetPublicKeyPEM retourne la clé publique en PEM
func (ks *Keystore) GetPublicKeyPEM() (string, error) {
	if ks.publicKey == nil {
		return "", fmt.Errorf("no public key loaded")
	}
	return MarshalPublicKeyPEM(ks.publicKey)
}

// SaveSharedSecret sauvegarde le secret partagé
func (ks *Keystore) SaveSharedSecret(secret []byte) error {
	path := filepath.Join(ks.basePath, "shared.secret")
	return os.WriteFile(path, secret, 0600)
}

// LoadSharedSecret charge le secret partagé
func (ks *Keystore) LoadSharedSecret() ([]byte, error) {
	path := filepath.Join(ks.basePath, "shared.secret")
	return os.ReadFile(path)
}

// HasSharedSecret vérifie si le secret partagé existe
func (ks *Keystore) HasSharedSecret() bool {
	path := filepath.Join(ks.basePath, "shared.secret")
	_, err := os.Stat(path)
	return err == nil
}

