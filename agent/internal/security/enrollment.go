package security

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/nexus/agent/internal/collector"
)

// SendFunc envoie un message brut via WebSocket (injectée par main.go)
type SendFunc func(data []byte) error

// ReceiveFunc attend un message et le retourne (injectée par main.go)
type ReceiveFunc func(timeout time.Duration) ([]byte, error)

// EnrollResult contient le résultat de l'enrollment
type EnrollResult struct {
	MachineType string
}

// EnrollmentMessage reproduit la structure d'un message WS
// sans importer le package transport (éviter le cycle)
type EnrollmentMessage struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	MachineID string `json:"machine_id"`
	Timestamp string `json:"timestamp"`
	Nonce     string `json:"nonce"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// Enroll effectue le processus d'enrollment avec le serveur
func Enroll(
	sendFn SendFunc,
	receiveFn ReceiveFunc,
	machineID string,
	enrollmentToken string,
	serverPublicKeyPEM string,
	keystore *Keystore,
) (*EnrollResult, error) {
	log.Println("[Enrollment] Starting enrollment process...")

	// 1. Générer la paire de clés de l'agent
	if !keystore.HasKeypair() {
		log.Println("[Enrollment] Generating ECDSA keypair...")
		if err := keystore.GenerateAndSave(); err != nil {
			return nil, fmt.Errorf("failed to generate keypair: %w", err)
		}
	} else {
		if err := keystore.Load(); err != nil {
			return nil, fmt.Errorf("failed to load keypair: %w", err)
		}
	}

	// 2. Obtenir la clé publique de l'agent en PEM
	agentPubPEM, err := keystore.GetPublicKeyPEM()
	if err != nil {
		return nil, err
	}

	// 3. Signer le machineID comme preuve
	proof, err := SignPayload(machineID, keystore.GetPrivateKey())
	if err != nil {
		return nil, fmt.Errorf("failed to sign proof: %w", err)
	}

	// 4. Collecter les infos système
	sysInfo, err := collector.GetSystemInfo("")
	if err != nil {
		sysInfo = &collector.SystemInfo{OS: "unknown", Hostname: "unknown"}
	}

	// 5. Construire le message d'enrollment
	enrollPayload := map[string]interface{}{
		"enrollment_token": enrollmentToken,
		"agent_public_key": agentPubPEM,
		"proof":            proof,
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
		return nil, err
	}

	msg := EnrollmentMessage{
		V:         ProtocolVersion,
		Type:      "enrollment.request",
		MachineID: machineID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Nonce:     GenerateNonce(),
		Payload:   string(payloadJSON),
		Signature: "",
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}

	// 6. Envoyer la demande d'enrollment
	log.Println("[Enrollment] Sending enrollment request...")
	if err := sendFn(data); err != nil {
		return nil, fmt.Errorf("failed to send enrollment request: %w", err)
	}

	// 7. Attendre la réponse (timeout 30s)
	log.Println("[Enrollment] Waiting for response...")
	respData, err := receiveFn(30 * time.Second)
	if err != nil {
		return nil, fmt.Errorf("enrollment response timeout: %w", err)
	}

	var response EnrollmentMessage
	if err := json.Unmarshal(respData, &response); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if response.Type == "enrollment.rejected" {
		return nil, fmt.Errorf("enrollment rejected: %s", response.Payload)
	}

	if response.Type != "enrollment.complete" {
		return nil, fmt.Errorf("unexpected response type: %s", response.Type)
	}

	// Version de protocole de la réponse serveur : rejet explicite d'un backend v1.
	if response.V != ProtocolVersion {
		return nil, fmt.Errorf("unsupported protocol version %d in enrollment response (expected %d) — re-enroll", response.V, ProtocolVersion)
	}

	// 8. Vérifier la signature du serveur — PINNING STRICT : la clé serveur est
	// OBLIGATOIRE. Sans elle, un serveur non authentifié pourrait enrôler l'agent
	// (rupture d'isolation entre projets / MITM sur l'enrollement).
	if serverPublicKeyPEM == "" {
		return nil, fmt.Errorf("clé publique serveur obligatoire pour l'enrollement (pinning)")
	}
	pinnedServerKey, err := ParsePublicKeyPEM(serverPublicKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("failed to parse server public key: %w", err)
	}

	sigPayload := BuildSignaturePayload(
		response.V, response.Type, "", response.MachineID,
		response.Timestamp, response.Nonce, response.Payload,
	)
	if !VerifySignature(sigPayload, response.Signature, pinnedServerKey) {
		return nil, fmt.Errorf("server signature verification failed")
	}
	log.Println("[Enrollment] Server signature verified (pinned key)")

	// 9. Parser la réponse
	var responseData struct {
		MachineType     string `json:"machine_type"`
		ServerPublicKey string `json:"server_public_key"`
	}
	if err := json.Unmarshal([]byte(response.Payload), &responseData); err != nil {
		return nil, fmt.Errorf("failed to parse enrollment response: %w", err)
	}

	// 10. Dériver le secret partagé via ECDH avec la clé PINNÉE (et non celle
	// reçue dans le payload) : la signature ci-dessus prouve déjà que la réponse
	// vient du détenteur de la clé pinnée. On vérifie en plus que la clé du
	// payload correspond, par cohérence.
	if responseData.ServerPublicKey != "" {
		if respKey, perr := ParsePublicKeyPEM(responseData.ServerPublicKey); perr == nil {
			if !respKey.Equal(pinnedServerKey) {
				return nil, fmt.Errorf("server key in response does not match pinned key")
			}
		}
	}

	// Protocole v2 (CRYPTO-004) : plus de dérivation/persistance de secret de canal
	// à l'enrôlement. L'enrôlement n'établit que l'IDENTITÉ (agent.key ↔ machine
	// côté backend) ; la clé de session AES sera dérivée à chaque connexion par le
	// handshake ECDHE éphémère. On marque seulement l'enrôlement réussi.
	if err := keystore.MarkEnrolled(); err != nil {
		return nil, fmt.Errorf("failed to mark enrolled: %w", err)
	}

	log.Printf("[Enrollment] Complete! Machine type: %s", responseData.MachineType)

	return &EnrollResult{
		MachineType: responseData.MachineType,
	}, nil
}
