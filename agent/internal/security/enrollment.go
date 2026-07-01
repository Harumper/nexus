package security

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/nexus/agent/internal/collector"
)

// SendFunc sends a raw message over the WebSocket (injected by main.go)
type SendFunc func(data []byte) error

// ReceiveFunc waits for a message and returns it (injected by main.go)
type ReceiveFunc func(timeout time.Duration) ([]byte, error)

// EnrollmentMessage mirrors the structure of a WS message
// without importing the transport package (avoids the import cycle)
type EnrollmentMessage struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	MachineID string `json:"machine_id"`
	Timestamp string `json:"timestamp"`
	Nonce     string `json:"nonce"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// Enroll performs the enrollment process with the server
func Enroll(
	sendFn SendFunc,
	receiveFn ReceiveFunc,
	machineID string,
	enrollmentToken string,
	serverPublicKeyPEM string,
	keystore *Keystore,
) error {
	log.Println("[Enrollment] Starting enrollment process...")

	// 1. Generate the agent keypair
	if !keystore.HasKeypair() {
		log.Println("[Enrollment] Generating ECDSA keypair...")
		if err := keystore.GenerateAndSave(); err != nil {
			return fmt.Errorf("failed to generate keypair: %w", err)
		}
	} else {
		if err := keystore.Load(); err != nil {
			return fmt.Errorf("failed to load keypair: %w", err)
		}
	}

	// 2. Get the agent's public key in PEM
	agentPubPEM, err := keystore.GetPublicKeyPEM()
	if err != nil {
		return err
	}

	// NEXUS-ENROLLMENT-002 — freshness generated BEFORE the proof and bound INSIDE
	// the authenticated seal (not the external envelope, which is modifiable
	// on-path). The proof signs a composite payload (machineID|token|nonce|timestamp)
	// instead of the static machineID alone: it becomes fresh and non-replayable,
	// and binds key possession to THIS specific enrollment.
	nonce := GenerateNonce()
	timestamp := time.Now().UTC().Format(time.RFC3339)

	// 3. Sign the composite payload as proof (bound to token + nonce + timestamp)
	proof, err := SignPayload(
		BuildEnrollmentProofPayload(machineID, enrollmentToken, nonce, timestamp),
		keystore.GetPrivateKey(),
	)
	if err != nil {
		return fmt.Errorf("failed to sign proof: %w", err)
	}

	// 4. Collect system info
	sysInfo, err := collector.GetSystemInfo("")
	if err != nil {
		sysInfo = &collector.SystemInfo{OS: "unknown", Hostname: "unknown"}
	}

	// 5. Build the enrollment message. nonce + timestamp are placed INSIDE the
	// sealed payload: the backend reads them from the authenticated seal to validate
	// the time window and anti-replay, and to rebuild the proof.
	enrollPayload := map[string]interface{}{
		"enrollment_token": enrollmentToken,
		"agent_public_key": agentPubPEM,
		"proof":            proof,
		"nonce":            nonce,
		"timestamp":        timestamp,
		"system_info": map[string]interface{}{
			"os":         sysInfo.OS,
			"os_version": sysInfo.OSVersion,
			"hostname":   sysInfo.Hostname,
			"arch":       sysInfo.Arch,
			"kernel":     sysInfo.Kernel,
			"ips":        sysInfo.IPs,
		},
	}

	payloadJSON, err := json.Marshal(enrollPayload)
	if err != nil {
		return err
	}

	// STRICT PINNING: the server key is MANDATORY (isolation between projects /
	// bootstrap MITM) AND needed HERE to seal the request.
	if serverPublicKeyPEM == "" {
		return fmt.Errorf("server public key mandatory for enrollment (pinning)")
	}
	pinnedServerKey, err := ParsePublicKeyPEM(serverPublicKeyPEM)
	if err != nil {
		return fmt.Errorf("failed to parse server public key: %w", err)
	}

	// NEXUS-ENROLLMENT-001 (seal): seal the request (token + agent public key +
	// proof) to the PINNED server key (ECIES P-256). Token confidentiality +
	// pubkey integrity, even if TLS is stripped/terminated at the proxy — an
	// on-path attacker without the server private key can neither read the token
	// nor substitute the agent pubkey.
	ephPubPEM, sealed, err := SealToServer(payloadJSON, pinnedServerKey, machineID)
	if err != nil {
		return fmt.Errorf("failed to seal enrollment request: %w", err)
	}
	sealedEnvelope, err := json.Marshal(map[string]string{
		"eph_pub": ephPubPEM,
		"sealed":  sealed,
	})
	if err != nil {
		return err
	}

	msg := EnrollmentMessage{
		V:         ProtocolVersion,
		Type:      "enrollment.request",
		MachineID: machineID,
		// Same nonce/timestamp as those sealed and signed in the proof (consistency).
		// The backend validates freshness on the SEALED copies, not on the envelope.
		Timestamp: timestamp,
		Nonce:     nonce,
		Payload:   string(sealedEnvelope),
		Signature: "",
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// 6. Send the enrollment request
	log.Println("[Enrollment] Sending enrollment request...")
	if err := sendFn(data); err != nil {
		return fmt.Errorf("failed to send enrollment request: %w", err)
	}

	// 7. Wait for the response (30s timeout)
	log.Println("[Enrollment] Waiting for response...")
	respData, err := receiveFn(30 * time.Second)
	if err != nil {
		return fmt.Errorf("enrollment response timeout: %w", err)
	}

	var response EnrollmentMessage
	if err := json.Unmarshal(respData, &response); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	if response.Type == "enrollment.rejected" {
		return fmt.Errorf("enrollment rejected: %s", response.Payload)
	}

	if response.Type != "enrollment.complete" {
		return fmt.Errorf("unexpected response type: %s", response.Type)
	}

	// Server response protocol version: explicit rejection of a v1 backend.
	if response.V != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %d in enrollment response (expected %d) — re-enroll", response.V, ProtocolVersion)
	}

	// 8. Verify the server signature with the PINNED key (already parsed above to
	// seal the request). The signature proves the response comes from the holder
	// of the pinned key.
	sigPayload := BuildSignaturePayload(
		response.V, response.Type, "", response.MachineID,
		response.Timestamp, response.Nonce, response.Payload,
	)
	if !VerifySignature(sigPayload, response.Signature, pinnedServerKey) {
		return fmt.Errorf("server signature verification failed")
	}
	log.Println("[Enrollment] Server signature verified (pinned key)")

	// 9. Parse the response
	var responseData struct {
		ServerPublicKey string `json:"server_public_key"`
	}
	if err := json.Unmarshal([]byte(response.Payload), &responseData); err != nil {
		return fmt.Errorf("failed to parse enrollment response: %w", err)
	}

	// 10. Derive the shared secret via ECDH with the PINNED key (not the one
	// received in the payload): the signature above already proves the response
	// comes from the holder of the pinned key. We additionally verify that the key
	// in the payload matches, for consistency.
	if responseData.ServerPublicKey != "" {
		if respKey, perr := ParsePublicKeyPEM(responseData.ServerPublicKey); perr == nil {
			if !respKey.Equal(pinnedServerKey) {
				return fmt.Errorf("server key in response does not match pinned key")
			}
		}
	}

	// Protocol v2 (CRYPTO-004): no more channel secret derivation/persistence at
	// enrollment. Enrollment establishes only IDENTITY (agent.key ↔ machine on the
	// backend side); the AES session key will be derived on each connection by the
	// ephemeral ECDHE handshake. We only mark the enrollment as successful.
	if err := keystore.MarkEnrolled(); err != nil {
		return fmt.Errorf("failed to mark enrolled: %w", err)
	}

	log.Println("[Enrollment] Complete!")

	return nil
}
