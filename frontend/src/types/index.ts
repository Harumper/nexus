export interface User {
  id: string;
  username: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "READONLY";
  lastLogin?: string;
  createdAt: string;
}

export interface Machine {
  id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  ipAddress: string | null;
  agentVersion: string | null;
  status: MachineStatus;
  type: "AGENT" | "PROBE";
  sshUser: string | null;
  isCritical: boolean;
  sudoersHash?: string | null;
  sudoersOutdated?: boolean;
  expectedSudoersHash?: string;
  lastHeartbeat: string | null;
  lastMetrics: string | null;
  enrolledAt: string | null;
  createdAt: string;
  tags?: { tag: Tag }[];
  rebootRequired?: boolean;
  /** Présence WebSocket live. Peut être false alors que status=ONLINE
   * pendant la grâce de 90s anti-flapping côté backend. */
  isConnected?: boolean;
  /** Le binaire agent en cours diffère de celui servi par le serveur. */
  agentUpdateAvailable?: boolean;
}

export type MachineStatus =
  | "ENROLLMENT_PENDING"
  | "ONLINE"
  | "OFFLINE"
  | "DEGRADED"
  | "REVOKED";

export interface FsEntry {
  name: string;
  kind: "file" | "dir" | "symlink" | "device" | "pipe" | "socket" | "other";
  size: number;
  mode: string;
  mtime: string;
  denied?: boolean;
  symlink?: string;
}

export interface InstallStep {
  id: string;
  title: string;
  description: string;
  command: string;
}

export interface BootstrapArtifacts {
  installSteps: InstallStep[];
  installCommand: string;
  expiresAt: string;
}

export interface CreateMachineResponse {
  id: string;
  name: string;
  enrollmentToken: string;
  backendPublicKey: string;
  expiresAt: string;
  bootstrap: BootstrapArtifacts | null;
}

export interface Metric {
  id: string;
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  disks: DiskInfo[];
  network: any;
  loadAvg1: number | null;
  loadAvg5: number | null;
  loadAvg15: number | null;
  uptime: number | null;
  timestamp: string;
}

export interface DiskInfo {
  mountpoint: string;
  filesystem?: string;
  total: number;
  used: number;
  free: number;
  percent: number;
}

export interface LynisItem {
  id: string;
  text: string;
}

export interface ListeningService {
  proto: string;
  address: string;
  port: string;
  process: string;
  exposed: boolean;
  is_ssh: boolean;
}

export interface SecurityAuditResult {
  hardening_index: number; // -1 si non disponible
  lynis_version: string;
  warnings: LynisItem[];
  suggestions: LynisItem[];
  warning_count: number;
  suggestion_count: number;
  firewall_active: boolean;
  firewall_empty_ruleset: boolean;
  scan_date: string;
  lynis_installed_now: boolean;
  lynis_path: string;
  // État des remédiations « 1 clic » (Phase 2)
  fail2ban_installed: boolean;
  fail2ban_active: boolean;
  auto_updates_active: boolean;
  ssh_hardened: boolean;
}

export interface MetricsResponse {
  machineId: string;
  range: string;
  count: number;
  metrics: Metric[];
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  provider: "local" | "keycloak" | null;
}

export interface AuthConfig {
  mode: "local" | "keycloak" | "both";
  local: boolean;
  keycloak: {
    url: string;
    realm: string;
    clientId: string;
  } | null;
  features?: {
    // Gestion des clés SSH / sudo via l'UI (désactivé par défaut côté backend).
    userPrivilegeMgmt?: boolean;
  };
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  _count?: { machines: number };
}

export interface Setting {
  key: string;
  value: any;
  updatedAt: string;
}

// WebSocket dashboard messages
export interface WSDashboardMessage {
  type: string;
  machine_id?: string;
  data?: any;
}
