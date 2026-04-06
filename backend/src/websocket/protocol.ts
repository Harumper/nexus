// Types de messages WebSocket

export const MSG_TYPES = {
  // Agent -> Server
  ENROLLMENT_REQUEST: "enrollment.request",
  HEARTBEAT: "heartbeat",
  METRICS_REPORT: "metrics.report",
  ACTION_RESPONSE: "action.response",
  SYSTEM_INFO: "system.info",
  UPDATE_PROGRESS: "update.progress",

  // Server -> Agent
  ENROLLMENT_COMPLETE: "enrollment.complete",
  ENROLLMENT_REJECTED: "enrollment.rejected",
  ACTION_REQUEST: "action.request",
  CAPABILITIES_UPDATE: "capabilities.update",
  PING: "ping",
  PONG: "pong",
} as const;

export type MessageType = (typeof MSG_TYPES)[keyof typeof MSG_TYPES];

// Messages qui ne nécessitent pas d'authentification
export const UNAUTHENTICATED_TYPES = new Set<string>([
  MSG_TYPES.ENROLLMENT_REQUEST,
]);
