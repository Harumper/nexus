import { prisma } from "./database.js";
import { pushMetric } from "./metrics-buffer.js";
import type { MetricsReport, HeartbeatData } from "../types/index.js";

const HEARTBEAT_TIMEOUT = parseInt(
  process.env.HEARTBEAT_TIMEOUT_SECONDS || "90",
  10
);

export async function processHeartbeat(
  machineId: string,
  data: HeartbeatData
): Promise<void> {
  await prisma.machine.update({
    where: { id: machineId },
    data: {
      lastHeartbeat: new Date(),
      agentVersion: data.agent_version || undefined,
      sudoersHash: data.sudoers_hash || undefined,
      agentSha256: data.agent_sha256 || undefined,
      status: "ONLINE",
    },
  });

  // No "heartbeat" machineEvent: it was pure noise (never consulted,
  // ~288k rows/day for 100 agents). lastHeartbeat on Machine is enough.
}

export async function processMetrics(
  machineId: string,
  metrics: MetricsReport
): Promise<void> {
  // Live only: keep the report in the in-memory buffer (no persistence). Long-term
  // history is Prometheus/Grafana via the per-machine gauges (fed separately in
  // prometheus.ts). The Prometheus feed and alert evaluation do NOT read this.
  pushMetric(machineId, metrics);

  await prisma.machine.update({
    where: { id: machineId },
    data: { lastMetrics: new Date() },
  });
}

export async function checkOfflineMachines(): Promise<void> {
  const threshold = new Date(Date.now() - HEARTBEAT_TIMEOUT * 1000);

  await prisma.machine.updateMany({
    where: {
      status: "ONLINE",
      lastHeartbeat: { lt: threshold },
    },
    data: { status: "OFFLINE" },
  });
}

// READ-ONLY actions (monitoring, do not mutate the host). Single source of
// truth reused by privileged-actions.ts to distinguish reads vs writes in the
// gating of privileged actions (WEB-AUTHZ). Formerly the list of actions
// allowed for the PROBE type (removed); its true role has always been
// "read-only", hence the renaming.
export const READ_ONLY_ACTIONS = [
  "system.metrics",
  "system.info",
  "system.processes",
  "system.heartbeat",
  "system.logs",
  "system.services_list",
  "system.service_status",
  "system.package_list",
  "firewall.status",
  "storage.lvm_list",
  "storage.block_devices",
  "storage.filesystem_usage",
  "cron.list",
  "timer.list",
  "user.list",
  "sshkey.list",
  "network.status",
  "network.interfaces",
  "network.listening_services",
  "netplan.get",
  "package.holds_list",
  "system.services_failed",
  "system.timers_failed",
  "system.updates_available",
  "system.health_summary",
  "ssl.scan",
  "security.audit",
  "agent.sudoers_check",
  // File browser: list/read are read-only (fs.upload mutates → excluded).
  "fs.list",
  "fs.read",
  // Log shipping: status is read-only (configure/disable/install mutate → excluded).
  "logs.shipping_status",
  // Node-exporter: status is read-only (install/uninstall mutate → excluded).
  "monitoring.node_exporter_status",
];
