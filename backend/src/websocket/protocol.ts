// Types de messages WebSocket

// Version du protocole de canal (enveloppe + handshake). Liée DANS la signature de
// chaque message pour empêcher tout downgrade. Doit rester en phase avec
// transport.ProtocolVersion et security.ProtocolVersion côté agent. v1 est rejeté.
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

  // Server -> Agent
  ENROLLMENT_COMPLETE: "enrollment.complete",
  ENROLLMENT_REJECTED: "enrollment.rejected",
  ACTION_REQUEST: "action.request",
  ACTION_CONFIRM: "action.confirm",
  PING: "ping",
  PONG: "pong",
} as const;

// Messages qui ne nécessitent pas d'authentification
export const UNAUTHENTICATED_TYPES = new Set<string>([
  MSG_TYPES.ENROLLMENT_REQUEST,
]);
