// WebSocket message types

// Channel protocol version (envelope + handshake). Bound INTO the signature of
// every message to prevent any downgrade. Must stay in sync with
// transport.ProtocolVersion and security.ProtocolVersion on the agent side.
// v1 is rejected.
export const PROTOCOL_VERSION = 2;

export const MSG_TYPES = {
  // Agent -> Server
  ENROLLMENT_REQUEST: "enrollment.request",
  HEARTBEAT: "heartbeat",
  METRICS_REPORT: "metrics.report",
  ACTION_RESPONSE: "action.response",
  SYSTEM_INFO: "system.info",
  UPDATE_PROGRESS: "update.progress",
  AGENT_UPGRADE_PROGRESS: "agent.upgrade.progress",
  SECURITY_PROGRESS: "security.audit.progress",

  // Session handshake (ECDHE X25519, forward secrecy)
  SESSION_HELLO: "session.hello",          // Agent -> Server
  SESSION_HELLO_ACK: "session.hello.ack",  // Server -> Agent

  // Server -> Agent
  ENROLLMENT_COMPLETE: "enrollment.complete",
  ENROLLMENT_REJECTED: "enrollment.rejected",
  ACTION_REQUEST: "action.request",
  ACTION_CONFIRM: "action.confirm",
  PING: "ping",
  PONG: "pong",
} as const;

// Messages that do not require authentication
export const UNAUTHENTICATED_TYPES = new Set<string>([
  MSG_TYPES.ENROLLMENT_REQUEST,
]);
