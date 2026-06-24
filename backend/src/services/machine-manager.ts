import { prisma } from "./database.js";
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

  // Pas de machineEvent "heartbeat" : c'était du bruit pur (jamais consulté,
  // ~288k lignes/jour pour 100 agents). lastHeartbeat sur Machine suffit.
}

export async function processMetrics(
  machineId: string,
  metrics: MetricsReport
): Promise<void> {
  await prisma.metric.create({
    data: {
      machineId,
      cpuPercent: metrics.cpu_percent,
      memoryUsed: BigInt(metrics.memory_used),
      memoryTotal: BigInt(metrics.memory_total),
      memoryPercent: metrics.memory_percent,
      disks: metrics.disks as any,
      network: metrics.network as any,
      loadAvg1: metrics.load_avg_1,
      loadAvg5: metrics.load_avg_5,
      loadAvg15: metrics.load_avg_15,
      uptime: metrics.uptime ? BigInt(metrics.uptime) : null,
    },
  });

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

// Actions autorisees pour une machine de type PROBE (monitoring read-only).
// Les machines AGENT peuvent tout faire.
export const PROBE_ALLOWED_ACTIONS = [
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
  "netplan.get",
  "package.holds_list",
  "system.services_failed",
  "system.timers_failed",
  "system.updates_available",
  "system.health_summary",
  "ssl.scan",
  "agent.sudoers_check",
  // File browser : list/read en lecture seule autorisés en mode PROBE.
  // L'upload (fs.upload) reste réservé aux machines AGENT.
  "fs.list",
  "fs.read",
];

export async function isActionAllowed(
  machineId: string,
  actionId: string
): Promise<boolean> {
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { type: true },
  });
  if (!machine) return false;
  if (machine.type === "AGENT") return true;
  return PROBE_ALLOWED_ACTIONS.includes(actionId);
}
