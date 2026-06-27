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

// Protocole v2 (CRYPTO-004) : la clé de session AES n'est PLUS persistée — elle
// est dérivée à chaque connexion via le handshake ECDHE éphémère (forward
// secrecy). On ne garde sur disque que l'identité long-terme (agent.key) et un
// marqueur d'enrôlement réussi (l'ancien rôle « double » de shared.secret comme
// preuve d'enrôlement est repris par ce marqueur, sans secret de canal au repos).

// MarkEnrolled écrit le marqueur d'enrôlement réussi (purgé au --reenroll qui fait
// table rase de $KEY_DIR).
func (ks *Keystore) MarkEnrolled() error {
	path := filepath.Join(ks.basePath, "enrolled")
	return os.WriteFile(path, []byte("v2\n"), 0600)
}

// IsEnrolled indique si l'agent a déjà complété un enrôlement (identité présente).
func (ks *Keystore) IsEnrolled() bool {
	path := filepath.Join(ks.basePath, "enrolled")
	_, err := os.Stat(path)
	return err == nil
}

