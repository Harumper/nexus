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

// Keystore gère le stockage des clés sur disque
type Keystore struct {
	basePath   string
	privateKey *ecdsa.PrivateKey
	publicKey  *ecdsa.PublicKey
}

func NewKeystore(basePath string) *Keystore {
	return &Keystore{basePath: basePath}
}

// NEXUS-CRYPTO-001 — chiffrement au repos de agent.key (machine-binding LOGICIEL).
//
// Variables (et non const) pour permettre l'injection en test ; valeurs de prod
// figées. La clé d'enrobage est dérivée de machine-id (non-secret) + un sel
// par-install. Couture `wrappingKey()` ISOLÉE pour greffer un backend TPM plus
// tard (DEF-1) sans réécrire GenerateAndSave/Load.
//
// CE QUE ÇA PROTÈGE :
//   - copie du fichier agent.key SEUL (sans machine-id ni sel) → inutilisable ;
//   - réutilisation sur une AUTRE machine (machine-id différent) → échec ;
//   - process live non-root/non-agent → fermé par AGENT-002 (cap retirée).
//
// CE QUE ÇA NE PROTÈGE PAS (limite documentée — README/fix) :
//   - SNAPSHOT / BACKUP DISQUE COMPLET (PBS, Proxmox) : machine-id ET le sel y
//     voyagent → la clé d'enrobage est re-dérivable. SEUL LE TPM (DEF-1) ferme ce cas.
//   - compromission live de l'user nexus-agent ou root : a tous les inputs.
var (
	machineIDPath = "/etc/machine-id"
	keySaltPath   = "/etc/nexus/agent-keysalt" // root:nexus-agent 0640, scope-split du KEY_DIR
)

// wrappingKey dérive la clé AES-256 d'enrobage : HKDF(machine-id, sel, info).
// Sel séparé du KEY_DIR (config vs state) : une exfil scopée d'un seul dir rate
// une moitié. Fail-closed : machine-id/sel absent ou trop court → erreur.
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

// sealAtRest chiffre EN MÉMOIRE (AES-256-GCM, format "nonce:ciphertext"). Le clair
// n'est jamais écrit sur disque par l'appelant.
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

// openAtRest déchiffre (tag GCM vérifié par DecryptAES, lève si invalide).
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

	privPath := filepath.Join(ks.basePath, "agent.key")
	pubPath := filepath.Join(ks.basePath, "agent.pub")

	// NEXUS-CRYPTO-001 : chiffrer EN MÉMOIRE avant tout WriteFile. Le PEM clair de
	// la clé privée ne touche JAMAIS le disque — l'unique écriture est le chiffré.
	sealed, err := sealAtRest([]byte(privPEM))
	if err != nil {
		return fmt.Errorf("seal agent key at rest: %w", err)
	}
	if err := os.WriteFile(privPath, []byte(sealed), 0600); err != nil {
		return fmt.Errorf("failed to write private key: %w", err)
	}
	// La clé PUBLIQUE reste en clair (elle est publique).
	if err := os.WriteFile(pubPath, []byte(pubPEM), 0644); err != nil {
		return fmt.Errorf("failed to write public key: %w", err)
	}

	ks.privateKey = priv
	ks.publicKey = &priv.PublicKey

	return nil
}

// Load charge les clés depuis le disque (déchiffre agent.key au repos).
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

	// Auto-migration : un agent d'avant CRYPTO-001 a une clé en CLAIR. On la
	// re-chiffre EN PLACE, sans laisser de clair derrière (temp chiffré + rename
	// atomique ; pas de .bak, pas de fichier temp en clair). Non-fatal : la clé
	// est déjà chargée.
	if legacy {
		if err := rewriteEncryptedInPlace(privPath, privPEM); err != nil {
			log.Printf("[Keystore] at-rest migration warning (clé chargée, re-chiffrement à refaire au prochain boot): %v", err)
		} else {
			log.Printf("[Keystore] agent.key migrée vers le chiffrement au repos (CRYPTO-001)")
		}
	}
	return nil
}

// decryptOrDetectLegacy : si le contenu est un PEM CLAIR (legacy pré-CRYPTO-001),
// le retourne tel quel avec legacy=true ; sinon déchiffre le blob au repos.
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

// rewriteEncryptedInPlace re-chiffre le PEM et remplace le fichier de façon
// atomique. Le fichier temporaire contient le CHIFFRÉ (jamais le clair) ; le
// rename écrase l'ancien fichier (pas de .bak). Aucun clair ne subsiste.
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
