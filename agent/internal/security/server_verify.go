package security

import (
	"crypto/ecdsa"
	"fmt"
	"sync"
	"time"
)

// VerifyServerMessageInput groups the verified fields of a message
// received from the backend. Decoupled from transport.Message to avoid the import cycle.
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

// nonceStore keeps in memory the nonces already seen within the timestamp window
// to block replays on the agent side (defense in depth; the backend already uses
// an equivalent LRU cache on the server side).
var (
	nonceStore = struct {
		sync.Mutex
		seen map[string]time.Time
	}{seen: make(map[string]time.Time)}

	// Aligned with the timestamp window (5 min) — any older nonce is rejected by
	// IsTimestampValid anyway, so we purge it.
	nonceTTL = 5 * time.Minute
)

// rememberNonce returns true if the nonce is new, false if it has already been
// seen within the TTL window (= replay attack).
func rememberNonce(nonce string) bool {
	nonceStore.Lock()
	defer nonceStore.Unlock()

	now := time.Now()

	// Opportunistic purge of expired nonces (no dedicated goroutine, sufficient
	// since the map grows slowly and we purge on every insert)
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

// VerifyServerMessage validates a message received from the backend:
//  1. Timestamp within the 5 min window (anti-drift + anti old-replay)
//  2. Nonce not seen (strict anti-replay)
//  3. Valid ECDSA signature with the server's public key
//
// To be called BEFORE any sensitive action (notably action.confirm, which
// cancels a firewall/netplan watchdog-revert).
func VerifyServerMessage(msg VerifyServerMessageInput, serverPubKey *ecdsa.PublicKey) error {
	// Protocol version first: a message from a v1 backend (or without a v field)
	// is rejected explicitly, not processed blindly.
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

	// NEXUS-CRYPTO-005 (agent mirror): we record the nonce only AFTER the signature
	// verification, so that an unauthenticated message cannot poison the agent-side
	// anti-replay cache (defense in depth).
	if !rememberNonce(msg.Nonce) {
		return fmt.Errorf("duplicate nonce (replay): %s", msg.Nonce)
	}

	return nil
}
