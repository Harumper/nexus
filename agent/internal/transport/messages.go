package transport

// ProtocolVersion is the channel protocol version (envelope + handshake).
// Bound INTO the signature of every message (cf. SendSigned /
// BuildSignaturePayload) to prevent any downgrade. Must stay in sync with
// security.ProtocolVersion (verification side) and PROTOCOL_VERSION (backend).
// v1 (without this field) is rejected.
const ProtocolVersion = 2

// Message represents a WebSocket message
type Message struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"request_id,omitempty"`
	MachineID string `json:"machine_id"`
	Timestamp string `json:"timestamp"`
	Nonce     string `json:"nonce"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
	// Error is present in "error" type messages sent by the backend
	Error string `json:"error,omitempty"`
}

// SimpleMessage for unsigned messages (errors, etc.)
type SimpleMessage struct {
	Type  string `json:"type"`
	Error string `json:"error,omitempty"`
	Data  any    `json:"data,omitempty"`
}

// ActionRequestPayload is the decrypted payload of an action request
type ActionRequestPayload struct {
	RequestID string                 `json:"request_id"`
	ActionID  string                 `json:"action_id"`
	Params    map[string]interface{} `json:"params"`
}

const (
	TypeEnrollmentRequest    = "enrollment.request"
	TypeEnrollmentComplete   = "enrollment.complete"
	TypeEnrollmentRejected   = "enrollment.rejected"
	TypeSessionHello         = "session.hello"
	TypeSessionHelloAck      = "session.hello.ack"
	TypeHeartbeat            = "heartbeat"
	TypeMetricsReport        = "metrics.report"
	TypeActionRequest        = "action.request"
	TypeActionConfirm        = "action.confirm"
	TypeActionResponse       = "action.response"
	TypeUpdateProgress       = "update.progress"
	TypeAgentUpgradeProgress = "agent.upgrade.progress"
	TypeSecurityProgress     = "security.audit.progress"
	TypePing                 = "ping"
	TypePong                 = "pong"
	TypeError                = "error"
)
