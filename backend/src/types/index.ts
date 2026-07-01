// ===================== WebSocket Protocol =====================

export interface WSMessage {
  v: number; // channel protocol version (bound into the signature; v1 rejected)
  type: string;
  request_id?: string;
  machine_id: string;
  timestamp: string;
  nonce: string;
  payload: string; // AES-256-GCM encrypted JSON (or plaintext during enrollment)
  signature: string; // ECDSA signature
}

export interface EnrollmentRequest {
  enrollment_token: string;
  agent_public_key: string;
  proof: string; // ECDSA signature of the composite enrollment-proof payload
  // NEXUS-ENROLLMENT-002 — freshness sealed inside the request: the proof is
  // bound to (machine_id|token|nonce|timestamp), and the backend rejects a stale
  // timestamp or a replayed nonce.
  nonce: string;
  timestamp: string;
  system_info: SystemInfo;
}

export interface EnrollmentComplete {
  server_public_key: string;
  shared_secret_encrypted: string; // Agent's public key encrypted shared secret
}

export interface HeartbeatData {
  uptime: number;
  agent_version: string;
  agent_type?: string;
  reboot_required?: boolean;
  sudoers_hash?: string;
  // SHA256 of the running agent binary (detects "up to date" / upgrade completion)
  agent_sha256?: string;
}

export interface MetricsReport {
  cpu_percent: number;
  memory_used: number;
  memory_total: number;
  memory_percent: number;
  disks: DiskInfo[];
  network?: NetworkInfo;
  load_avg_1?: number;
  load_avg_5?: number;
  load_avg_15?: number;
  uptime?: number;
}

export interface DiskInfo {
  mountpoint: string;
  used: number;
  total: number;
  percent: number;
  filesystem?: string;
}

export interface NetworkInfo {
  interfaces: NetworkInterface[];
}

export interface NetworkInterface {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface SystemInfo {
  os: string;
  os_version: string;
  hostname: string;
  arch: string;
  kernel?: string;
  ips?: string[];
}

export interface ActionRequest {
  action_id: string;
  params?: Record<string, unknown>;
}

export interface ActionResponse {
  request_id: string;
  action_id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ===================== API Types =====================

export interface CreateMachineBody {
  name: string;
}

export interface LoginBody {
  username: string;
  password: string;
}

export interface DispatchActionBody {
  action_id: string;
  params?: Record<string, unknown>;
}

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  provider?: "local" | "keycloak";
  email?: string;
}

// ===================== Agent Session =====================

export interface AgentSession {
  machineId: string;
  ws: import("ws").WebSocket;
  authenticated: boolean;
  connectedAt: Date;
  lastHeartbeat: Date;
  ip: string;
  // CRYPTO-004: EPHEMERAL AES session key, derived by the ECDHE X25519 handshake
  // when the connection is established. MEMORY ONLY — never persisted (neither
  // DB nor disk). Destroyed with the session lifecycle.
  sessionKey?: Buffer;
  // ECDHE handshake completed on this connection (session.hello received+verified,
  // K derived). While false, no business message is processed.
  established?: boolean;
}
