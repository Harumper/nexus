import client from "prom-client";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "./database.js";
import { getConnectedMachineIds } from "../websocket/sessions.js";
import { getDashboardClientCount } from "../websocket/dashboard.js";

// Prometheus registry
export const register = new client.Registry();

// Default Node.js metrics (GC, heap, event loop)
client.collectDefaultMetrics({ register, prefix: "nexus_" });

// ===================== Infra Nexus =====================

export const httpRequestsTotal = new client.Counter({
  name: "nexus_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: "nexus_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const wsAgentConnections = new client.Gauge({
  name: "nexus_ws_agent_connections",
  help: "Number of connected agents",
  registers: [register],
  collect() {
    this.set(getConnectedMachineIds().length);
  },
});

export const wsDashboardConnections = new client.Gauge({
  name: "nexus_ws_dashboard_connections",
  help: "Number of connected dashboard clients",
  registers: [register],
  collect() {
    this.set(getDashboardClientCount());
  },
});

export const uptimeGauge = new client.Gauge({
  name: "nexus_uptime_seconds",
  help: "Backend uptime in seconds",
  registers: [register],
  collect() {
    this.set(process.uptime());
  },
});

// ===================== Fleet =====================

export const machinesTotal = new client.Gauge({
  name: "nexus_machines_total",
  help: "Total machines by status",
  labelNames: ["status"] as const,
  registers: [register],
});

export const alertsFiring = new client.Gauge({
  name: "nexus_alerts_firing_total",
  help: "Number of currently firing alerts",
  registers: [register],
});

export const actionsDispatched = new client.Counter({
  name: "nexus_actions_dispatched_total",
  help: "Total actions dispatched to agents",
  registers: [register],
});

export const actionsFailed = new client.Counter({
  name: "nexus_actions_failed_total",
  help: "Total actions that failed",
  registers: [register],
});

// ===================== Machine metrics =====================

export const machineCpu = new client.Gauge({
  name: "nexus_machine_cpu_percent",
  help: "Machine CPU usage percent",
  labelNames: ["machine_id", "hostname"] as const,
  registers: [register],
});

export const machineMemoryUsed = new client.Gauge({
  name: "nexus_machine_memory_used_bytes",
  help: "Machine memory used in bytes",
  labelNames: ["machine_id", "hostname"] as const,
  registers: [register],
});

export const machineMemoryTotal = new client.Gauge({
  name: "nexus_machine_memory_total_bytes",
  help: "Machine memory total in bytes",
  labelNames: ["machine_id", "hostname"] as const,
  registers: [register],
});

export const machineMemoryPercent = new client.Gauge({
  name: "nexus_machine_memory_percent",
  help: "Machine memory usage percent",
  labelNames: ["machine_id", "hostname"] as const,
  registers: [register],
});

export const machineDiskPercent = new client.Gauge({
  name: "nexus_machine_disk_percent",
  help: "Machine disk usage percent",
  labelNames: ["machine_id", "hostname", "mountpoint"] as const,
  registers: [register],
});

export const machineLoadAvg1 = new client.Gauge({
  name: "nexus_machine_load_avg_1",
  help: "Machine 1-minute load average",
  labelNames: ["machine_id", "hostname"] as const,
  registers: [register],
});

export const machineUptime = new client.Gauge({
  name: "nexus_machine_uptime_seconds",
  help: "Machine uptime in seconds",
  labelNames: ["machine_id", "hostname"] as const,
  registers: [register],
});

// ===================== Helpers =====================

// Updates the machine gauges when metrics are received
export function updateMachineMetrics(
  machineId: string,
  hostname: string,
  metrics: {
    cpu_percent?: number;
    memory_used?: number;
    memory_total?: number;
    memory_percent?: number;
    disks?: Array<{ mountpoint: string; percent: number }>;
    load_avg_1?: number;
    uptime?: number;
  }
): void {
  const labels = { machine_id: machineId, hostname: hostname || machineId };

  if (metrics.cpu_percent !== undefined) machineCpu.set(labels, metrics.cpu_percent);
  if (metrics.memory_used !== undefined) machineMemoryUsed.set(labels, metrics.memory_used);
  if (metrics.memory_total !== undefined) machineMemoryTotal.set(labels, metrics.memory_total);
  if (metrics.memory_percent !== undefined) machineMemoryPercent.set(labels, metrics.memory_percent);
  if (metrics.load_avg_1 !== undefined) machineLoadAvg1.set(labels, metrics.load_avg_1);
  if (metrics.uptime !== undefined) machineUptime.set(labels, Number(metrics.uptime));

  if (Array.isArray(metrics.disks)) {
    for (const disk of metrics.disks) {
      machineDiskPercent.set(
        { machine_id: machineId, hostname: hostname || machineId, mountpoint: disk.mountpoint },
        disk.percent
      );
    }
  }
}

// Refreshes the fleet gauges (called periodically)
export async function refreshFleetMetrics(): Promise<void> {
  try {
    const counts = await prisma.machine.groupBy({
      by: ["status"],
      _count: true,
    });
    // Reset all status gauges
    machinesTotal.reset();
    for (const c of counts) {
      machinesTotal.set({ status: c.status }, c._count);
    }

    const firingCount = await prisma.alertState.count({
      where: { status: "FIRING" },
    });
    alertsFiring.set(firingCount);
  } catch {
    // Ignore errors during metric collection
  }
}

// ===================== Endpoint /metrics (NEXUS-WEB-AUTHZ-005) =====================
// /metrics exposes per-machine telemetry (machine_id, hostname, live CPU/mem/disk)
// for the whole fleet — a credential-less recon feed if it is reachable.
// Two controls, ADDITIVE (the token adds to network-scoping, does not replace it):
//  (A) METRICS_TOKEN set → this handler requires a bearer compared in CONSTANT
//      TIME (timingSafeEqual); fail-closed (absent/wrong → 401). Prometheus
//      scrapes with `authorization`/`bearer_token_file`.
//  (B) METRICS_TOKEN absent → no regression: the default control stays the
//      network-scoping (do not route /metrics through the public entrypoint).
// Reads METRICS_TOKEN at registration (like the rest of the boot config).
export function registerPrometheusEndpoint(app: FastifyInstance): void {
  const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
  app.get("/metrics", async (request, reply) => {
    if (METRICS_TOKEN) {
      const header = request.headers.authorization || "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      const expected = Buffer.from(METRICS_TOKEN);
      const got = Buffer.from(presented);
      // Constant-time comparison; the length check is required (timingSafeEqual
      // throws if the sizes differ) and the token length is not a secret.
      const ok = got.length === expected.length && timingSafeEqual(got, expected);
      if (!ok) {
        return reply.code(401).send("Unauthorized");
      }
    }
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
}
