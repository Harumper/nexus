import { prisma } from "./database.js";
import { decryptAES } from "./crypto.js";
import { assertSafeOutboundUrl, safeFetch } from "./net-guard.js";

// Settings keys utilises pour l'integration Nautilus
export const NAUTILUS_SETTINGS_KEYS = {
  ENABLED: "nautilus_enabled",
  URL: "nautilus_url",
  TOKEN: "nautilus_token",
} as const;

export interface NautilusConfig {
  enabled: boolean;
  url: string;
  token: string | null;
}

export interface ParsedMetric {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface NautilusSnapshot {
  scrapedAt: string;
  scrapeDurationMs: number;
  servers: NautilusServer[];
  containers: NautilusContainer[];
  meta: {
    totalServers: number;
    activeServers: number;
    scrapeSuccess: boolean;
  };
}

export interface NautilusServer {
  id: string;
  name: string;
  up: boolean;
  agentVersion: string | null;
  boundIp: string | null;
  lastPingAt: string | null;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  cpuCores: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
  containerCounts: Record<string, number>;
}

export interface NautilusContainer {
  serverId: string;
  serverName: string;
  name: string;
  containerId: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxRate: number | null;
  networkTxRate: number | null;
  pids: number;
}

export async function getNautilusConfig(): Promise<NautilusConfig> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: Object.values(NAUTILUS_SETTINGS_KEYS) } },
  });
  const map = new Map(settings.map((s) => [s.key, s.value]));

  const enabled = map.get(NAUTILUS_SETTINGS_KEYS.ENABLED);
  const url = map.get(NAUTILUS_SETTINGS_KEYS.URL);
  const rawToken = map.get(NAUTILUS_SETTINGS_KEYS.TOKEN);

  // Le token est chiffré au repos. On déchiffre ; si le déchiffrement échoue
  // (valeur legacy en clair stockée avant le chiffrement), on retombe sur la
  // valeur brute pour ne pas casser une intégration existante — elle sera
  // re-chiffrée à la prochaine sauvegarde.
  let token: string | null = null;
  if (typeof rawToken === "string" && rawToken.length > 0) {
    try {
      token = decryptAES(rawToken, process.env.ECDSA_MASTER_SECRET!);
    } catch {
      token = rawToken;
    }
  }

  return {
    enabled: enabled === true || enabled === "true",
    url: typeof url === "string" ? url : "http://localhost:26020/metrics",
    token,
  };
}

/**
 * Parse une ligne de format Prometheus text.
 * Format attendu : `metric_name{label="value",label2="value2"} 123.45`
 */
function parseMetricLine(line: string): ParsedMetric | null {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

  // Split metric name + labels block + value
  const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(.+)$/);
  if (!match) return null;

  const [, name, labelsStr, valueStr] = match;
  const labels: Record<string, string> = {};
  if (labelsStr) {
    // Parser simple : label="value" avec quoting standard
    const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = labelRegex.exec(labelsStr)) !== null) {
      labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }

  const value = parseFloat(valueStr);
  if (isNaN(value)) return null;

  return { name, labels, value };
}

export function parseMetricsText(text: string): ParsedMetric[] {
  const out: ParsedMetric[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseMetricLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Fetch + parse /metrics Nautilus et construit un snapshot structure.
 */
export async function fetchNautilusSnapshot(): Promise<NautilusSnapshot> {
  const cfg = await getNautilusConfig();
  if (!cfg.enabled) {
    throw new Error("Nautilus integration is disabled");
  }
  if (!cfg.url) {
    throw new Error("Nautilus URL is not configured");
  }
  // WEB-AUTHZ-001: the integration URL is operator-supplied config — same SSRF
  // egress guard as the alert webhooks.
  assertSafeOutboundUrl(cfg.url);

  const start = Date.now();
  const headers: Record<string, string> = {};
  if (cfg.token) headers["Authorization"] = `Bearer ${cfg.token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let text: string;
  try {
    const res = await safeFetch(cfg.url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Nautilus returned HTTP ${res.status}: ${await res.text()}`);
    }
    text = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const metrics = parseMetricsText(text);
  return buildSnapshot(metrics, Date.now() - start);
}

function buildSnapshot(metrics: ParsedMetric[], durationMs: number): NautilusSnapshot {
  const serverMap = new Map<string, NautilusServer>();
  const containers: NautilusContainer[] = [];
  let totalServers = 0;
  let activeServers = 0;
  let scrapeSuccess = true;

  const getServer = (serverId: string, serverName: string) => {
    let s = serverMap.get(serverId);
    if (!s) {
      s = {
        id: serverId,
        name: serverName,
        up: false,
        agentVersion: null,
        boundIp: null,
        lastPingAt: null,
        cpuPercent: 0,
        memoryUsedBytes: 0,
        memoryLimitBytes: 0,
        memoryPercent: 0,
        cpuCores: null,
        networkRxRate: null,
        networkTxRate: null,
        containerCounts: {},
      };
      serverMap.set(serverId, s);
    }
    return s;
  };

  for (const m of metrics) {
    const l = m.labels;
    switch (m.name) {
      case "nautilus_servers_total":
        if (l.state === "total") totalServers = m.value;
        else if (l.state === "active") activeServers = m.value;
        break;
      case "nautilus_scrape_success":
        scrapeSuccess = m.value === 1;
        break;
      case "nautilus_server_up":
        if (l.server_id) getServer(l.server_id, l.server).up = m.value === 1;
        break;
      case "nautilus_server_info":
        if (l.server_id) {
          const s = getServer(l.server_id, l.server);
          s.agentVersion = l.agent_version !== "unknown" ? l.agent_version : null;
          s.boundIp = l.bound_ip !== "unknown" ? l.bound_ip : null;
        }
        break;
      case "nautilus_server_last_ping_timestamp_seconds":
        if (l.server_id) {
          getServer(l.server_id, l.server).lastPingAt = new Date(m.value * 1000).toISOString();
        }
        break;
      case "nautilus_server_cpu_used_percent":
        if (l.server_id) getServer(l.server_id, l.server).cpuPercent = m.value;
        break;
      case "nautilus_server_memory_used_bytes":
        if (l.server_id) getServer(l.server_id, l.server).memoryUsedBytes = m.value;
        break;
      case "nautilus_server_memory_limit_bytes":
        if (l.server_id) getServer(l.server_id, l.server).memoryLimitBytes = m.value;
        break;
      case "nautilus_server_cpu_cores":
        if (l.server_id) getServer(l.server_id, l.server).cpuCores = m.value;
        break;
      case "nautilus_server_network_rx_rate_bytes":
        if (l.server_id) getServer(l.server_id, l.server).networkRxRate = m.value;
        break;
      case "nautilus_server_network_tx_rate_bytes":
        if (l.server_id) getServer(l.server_id, l.server).networkTxRate = m.value;
        break;
      case "nautilus_server_containers_total":
        if (l.server_id && l.state) {
          getServer(l.server_id, l.server).containerCounts[l.state] = m.value;
        }
        break;
      case "nautilus_container_cpu_percent":
      case "nautilus_container_memory_used_bytes":
      case "nautilus_container_memory_limit_bytes":
      case "nautilus_container_memory_percent":
      case "nautilus_container_network_rx_rate_bytes":
      case "nautilus_container_network_tx_rate_bytes":
      case "nautilus_container_pids":
        if (l.server_id && l.container && l.container_id) {
          let c = containers.find(
            (x) => x.serverId === l.server_id && x.containerId === l.container_id
          );
          if (!c) {
            c = {
              serverId: l.server_id,
              serverName: l.server,
              name: l.container,
              containerId: l.container_id,
              cpuPercent: 0,
              memoryUsedBytes: 0,
              memoryLimitBytes: 0,
              memoryPercent: 0,
              networkRxRate: null,
              networkTxRate: null,
              pids: 0,
            };
            containers.push(c);
          }
          if (m.name === "nautilus_container_cpu_percent") c.cpuPercent = m.value;
          else if (m.name === "nautilus_container_memory_used_bytes") c.memoryUsedBytes = m.value;
          else if (m.name === "nautilus_container_memory_limit_bytes") c.memoryLimitBytes = m.value;
          else if (m.name === "nautilus_container_memory_percent") c.memoryPercent = m.value;
          else if (m.name === "nautilus_container_network_rx_rate_bytes") c.networkRxRate = m.value;
          else if (m.name === "nautilus_container_network_tx_rate_bytes") c.networkTxRate = m.value;
          else if (m.name === "nautilus_container_pids") c.pids = m.value;
        }
        break;
    }
  }

  // Calculer memoryPercent server-side si pas fourni (devrait l'etre normalement)
  for (const s of serverMap.values()) {
    if (s.memoryLimitBytes > 0) {
      s.memoryPercent = (s.memoryUsedBytes / s.memoryLimitBytes) * 100;
    }
  }

  return {
    scrapedAt: new Date().toISOString(),
    scrapeDurationMs: durationMs,
    servers: Array.from(serverMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    containers: containers.sort((a, b) => b.cpuPercent - a.cpuPercent),
    meta: {
      totalServers,
      activeServers,
      scrapeSuccess,
    },
  };
}
