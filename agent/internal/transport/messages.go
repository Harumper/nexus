package transport

// ProtocolVersion est la version du protocole de canal (enveloppe + handshake).
// Liée DANS la signature de chaque message (cf. SendSigned / BuildSignaturePayload)
// pour empêcher tout downgrade. Doit rester en phase avec security.ProtocolVersion
// (côté vérification) et PROTOCOL_VERSION (backend). v1 (sans ce champ) est rejeté.
const ProtocolVersion = 2

// Message représente un message WebSocket
type Message struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"request_id,omitempty"`
	MachineID string `json:"machine_id"`
	Timestamp string `json:"timestamp"`
	Nonce     string `json:"nonce"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
	// Error est present dans les messages de type "error" envoyes par le backend
	Error string `json:"error,omitempty"`
}

// SimpleMessage pour les messages non signés (erreurs, etc.)
type SimpleMessage struct {
	Type    string `json:"type"`
	Error   string `json:"error,omitempty"`
	Data    any    `json:"data,omitempty"`
}

// ActionRequestPayload est le payload déchiffré d'une demande d'action
type ActionRequestPayload struct {
	RequestID string                 `json:"request_id"`
	ActionID  string                 `json:"action_id"`
	Params    map[string]interface{} `json:"params"`
}

const (
	TypeEnrollmentRequest  = "enrollment.request"
	TypeEnrollmentComplete = "enrollment.complete"
	TypeEnrollmentRejected = "enrollment.rejected"
	TypeSessionHello       = "session.hello"
	TypeSessionHelloAck    = "session.hello.ack"
	TypeHeartbeat          = "heartbeat"
	TypeMetricsReport      = "metrics.report"
	TypeActionRequest      = "action.request"
	TypeActionConfirm      = "action.confirm"
	TypeActionResponse     = "action.response"
	TypeUpdateProgress     = "update.progress"
	TypeAgentUpgradeProgress = "agent.upgrade.progress"
	TypeSecurityProgress   = "security.audit.progress"
	TypePing               = "ping"
	TypePong               = "pong"
	TypeError              = "error"
)
