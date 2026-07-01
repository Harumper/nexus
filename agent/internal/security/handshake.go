package security

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"golang.org/x/crypto/hkdf"
)

// deriveSessionKey computes the AES-256 session key from an X25519 ECDH secret,
// with domain-separation by machine_id (info="nexus-session:<id>", empty salt to
// match the backend crypto.hkdfSync).
func deriveSessionKey(ecdhSecret []byte, machineID string) ([]byte, error) {
	r := hkdf.New(sha256.New, ecdhSecret, nil, []byte("nexus-session:"+machineID))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("HKDF session key: %w", err)
	}
	return key, nil
}

// PerformSessionHandshake runs the X25519 ECDHE handshake (forward secrecy) over
// an ALREADY-established connection:
//  1. generates an ephemeral X25519 keypair,
//  2. sends session.hello {ephemeral_pub} SIGNED by the long-term key (unencrypted),
//  3. receives session.hello.ack, verifies it against the PINNED server key,
//  4. derives and returns the session key K.
//
// The ephemeral private key (eph) lives ONLY in this function: never stored in a
// struct, never logged, never returned. It goes out of scope on return → K cannot
// be recomputed even if the long-term key leaks later. K is neither persisted nor
// logged (memory only, returned to the caller).
func PerformSessionHandshake(
	send func([]byte) error,
	receive func(time.Duration) ([]byte, error),
	signKey *ecdsa.PrivateKey,
	serverPub *ecdsa.PublicKey,
	machineID string,
) ([]byte, error) {
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ephemeral keygen: %w", err)
	}

	helloPayload, _ := json.Marshal(map[string]string{
		"ephemeral_pub": base64.StdEncoding.EncodeToString(eph.PublicKey().Bytes()),
	})
	ts := time.Now().UTC().Format(time.RFC3339)
	nonce := GenerateNonce()
	sig, err := SignPayload(
		BuildSignaturePayload(ProtocolVersion, "session.hello", "", machineID, ts, nonce, string(helloPayload)),
		signKey,
	)
	if err != nil {
		return nil, fmt.Errorf("sign session.hello: %w", err)
	}
	hello, _ := json.Marshal(EnrollmentMessage{
		V: ProtocolVersion, Type: "session.hello", MachineID: machineID,
		Timestamp: ts, Nonce: nonce, Payload: string(helloPayload), Signature: sig,
	})
	if err := send(hello); err != nil {
		return nil, fmt.Errorf("send session.hello: %w", err)
	}

	ackRaw, err := receive(30 * time.Second)
	if err != nil {
		return nil, fmt.Errorf("await session.hello.ack: %w", err)
	}
	var ack EnrollmentMessage
	if err := json.Unmarshal(ackRaw, &ack); err != nil {
		return nil, fmt.Errorf("parse session.hello.ack: %w", err)
	}
	if ack.Type != "session.hello.ack" {
		return nil, fmt.Errorf("unexpected handshake response type: %q", ack.Type)
	}
	// Verify against the PINNED server key (version + timestamp + signature + nonce).
	if err := VerifyServerMessage(VerifyServerMessageInput{
		V: ack.V, Type: ack.Type, RequestID: "", MachineID: ack.MachineID,
		Timestamp: ack.Timestamp, Nonce: ack.Nonce, Payload: ack.Payload, Signature: ack.Signature,
	}, serverPub); err != nil {
		return nil, fmt.Errorf("verify session.hello.ack: %w", err)
	}

	var ackPayload struct {
		EphemeralPub string `json:"ephemeral_pub"`
	}
	if err := json.Unmarshal([]byte(ack.Payload), &ackPayload); err != nil {
		return nil, fmt.Errorf("parse ack payload: %w", err)
	}
	ebPubBytes, err := base64.StdEncoding.DecodeString(ackPayload.EphemeralPub)
	if err != nil {
		return nil, fmt.Errorf("decode server ephemeral pub: %w", err)
	}
	ebPub, err := ecdh.X25519().NewPublicKey(ebPubBytes)
	if err != nil {
		return nil, fmt.Errorf("parse server ephemeral pub: %w", err)
	}
	secret, err := eph.ECDH(ebPub)
	if err != nil {
		return nil, fmt.Errorf("X25519 ECDH: %w", err)
	}
	return deriveSessionKey(secret, machineID)
	// eph (ephemeral private key) goes out of scope → discarded. Forward secrecy.
}
