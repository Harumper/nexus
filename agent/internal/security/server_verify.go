package security

import (
	"crypto/ecdsa"
	"fmt"
	"sync"
	"time"
)

// VerifyServerMessageInput regroupe les champs verifies d'un message
// reçu du backend. Decouple de transport.Message pour eviter le cycle import.
type VerifyServerMessageInput struct {
	V         int
	Type      string
	RequestID string
	MachineID string
	Timestamp string
	Nonce     string
	Payload   string
	Signature string
}

// nonceStore garde en memoire les nonces deja vus dans la fenetre timestamp
// pour bloquer les replays cote agent (defense en profondeur, le backend
// utilise deja un cache LRU equivalent cote serveur).
var (
	nonceStore = struct {
		sync.Mutex
		seen map[string]time.Time
	}{seen: make(map[string]time.Time)}

	// Aligne sur la fenetre timestamp (5 min) — tout nonce plus vieux est
	// rejete par IsTimestampValid de toute facon, on le purge.
	nonceTTL = 5 * time.Minute
)

// rememberNonce retourne true si le nonce est nouveau, false s'il a deja
// ete vu dans la fenetre TTL (= replay attack).
func rememberNonce(nonce string) bool {
	nonceStore.Lock()
	defer nonceStore.Unlock()

	now := time.Now()

	// Purge opportuniste des nonces expires (sans goroutine dediee, sufficient
	// car la map croit lentement et on purge a chaque insert)
	for k, t := range nonceStore.seen {
		if now.Sub(t) > nonceTTL {
			delete(nonceStore.seen, k)
		}
	}

	if _, exists := nonceStore.seen[nonce]; exists {
		return false
	}
	nonceStore.seen[nonce] = now
	return true
}

// VerifyServerMessage valide un message recu du backend :
//  1. Timestamp dans la fenetre 5 min (anti drift + anti vieux replay)
//  2. Nonce non vu (anti replay strict)
//  3. Signature ECDSA valide avec la cle publique du serveur
//
// A appeler AVANT toute action sensible (notamment action.confirm qui
// annule un watchdog-revert firewall/netplan).
func VerifyServerMessage(msg VerifyServerMessageInput, serverPubKey *ecdsa.PublicKey) error {
	// Version de protocole d'abord : un message d'un backend v1 (ou sans champ v)
	// est rejeté explicitement, pas traité à l'aveugle.
	if msg.V != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %d (expected %d)", msg.V, ProtocolVersion)
	}

	if !IsTimestampValid(msg.Timestamp, 5*time.Minute) {
		return fmt.Errorf("timestamp outside valid window: %s", msg.Timestamp)
	}

	sigPayload := BuildSignaturePayload(
		msg.V, msg.Type, msg.RequestID, msg.MachineID,
		msg.Timestamp, msg.Nonce, msg.Payload,
	)
	if !VerifySignature(sigPayload, msg.Signature, serverPubKey) {
		return fmt.Errorf("invalid server signature")
	}

	// NEXUS-CRYPTO-005 (mirror agent) : on n'enregistre le nonce qu'APRÈS la
	// vérification de signature, pour qu'un message non authentifié ne puisse pas
	// empoisonner le cache anti-replay côté agent (défense en profondeur).
	if !rememberNonce(msg.Nonce) {
		return fmt.Errorf("duplicate nonce (replay): %s", msg.Nonce)
	}

	return nil
}
