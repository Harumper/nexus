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

	// NEXUS-ENROLLMENT-002 — freshness générée AVANT le proof et liée DANS le seal
	// authentifié (pas l'enveloppe externe, modifiable on-path). Le proof signe un
	// payload composite (machineID|token|nonce|timestamp) au lieu du seul machineID
	// statique : il devient frais et non rejouable, et lie la possession de la clé
	// à CET enrôlement précis.
	nonce := GenerateNonce()
	timestamp := time.Now().UTC().Format(time.RFC3339)

	// 3. Signer le payload composite comme preuve (lié au token + nonce + timestamp)
	proof, err := SignPayload(
		BuildEnrollmentProofPayload(machineID, enrollmentToken, nonce, timestamp),
		keystore.GetPrivateKey(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to sign proof: %w", err)
	}

	// 4. Collecter les infos système
	sysInfo, err := collector.GetSystemInfo("")
	if err != nil {
		sysInfo = &collector.SystemInfo{OS: "unknown", Hostname: "unknown"}
	}

	// 5. Construire le message d'enrollment. nonce + timestamp sont placés DANS le
	// payload scellé : le backend les lit depuis le seal authentifié pour valider
	// la fenêtre temporelle et l'anti-replay, et pour reconstruire le proof.
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
		return nil, err
	}

	// PINNING STRICT : la clé serveur est OBLIGATOIRE (isolation entre projets /
	// MITM bootstrap) ET nécessaire ICI pour sceller la requête.
	if serverPublicKeyPEM == "" {
		return nil, fmt.Errorf("clé publique serveur obligatoire pour l'enrollement (pinning)")
	}
	pinnedServerKey, err := ParsePublicKeyPEM(serverPublicKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("failed to parse server public key: %w", err)
	}

	// NEXUS-ENROLLMENT-001 (seal) : sceller la requête (token + clé publique agent
	// + proof) vers la clé serveur PINNÉE (ECIES P-256). Confidentialité du token +
	// intégrité de la pubkey, même si TLS est strippé/terminé au proxy — un
	// attaquant on-path sans la clé privée serveur ne peut ni lire le token ni
	// substituer la pubkey agent.
	ephPubPEM, sealed, err := SealToServer(payloadJSON, pinnedServerKey, machineID)
	if err != nil {
		return nil, fmt.Errorf("failed to seal enrollment request: %w", err)
	}
	sealedEnvelope, err := json.Marshal(map[string]string{
		"eph_pub": ephPubPEM,
		"sealed":  sealed,
	})
	if err != nil {
		return nil, err
	}

	msg := EnrollmentMessage{
		V:         ProtocolVersion,
		Type:      "enrollment.request",
		MachineID: machineID,
		// Mêmes nonce/timestamp que ceux scellés et signés dans le proof (cohérence).
		// Le backend valide la freshness sur les copies SCELLÉES, pas sur l'enveloppe.
		Timestamp: timestamp,
		Nonce:     nonce,
		Payload:   string(sealedEnvelope),
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

	// 8. Vérifier la signature du serveur avec la clé PINNÉE (déjà parsée plus haut
	// pour sceller la requête). La signature prouve que la réponse vient du
	// détenteur de la clé pinnée.
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
