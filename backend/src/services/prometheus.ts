import client from "prom-client";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "./database.js";
import { getConnectedMachineIds } from "../websocket/sessions.js";
import { getDashboardClientCount } from "../websocket/dashboard.js";

// Registry Prometheus
export const register = new client.Registry();

// Metriques Node.js par defaut (GC, heap, event loop)
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

// ===================== Metriques machines =====================

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

// Met a jour les gauges machine quand on recoit des metriques
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

// Rafraichit les gauges fleet (appele periodiquement)
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
// /metrics expose la télémétrie par machine (machine_id, hostname, CPU/mém/disque
// live) de toute la flotte — un flux de recon sans credentials s'il est joignable.
// Deux contrôles, ADDITIFS (le token s'ajoute au network-scoping, ne le remplace pas) :
//  (A) METRICS_TOKEN défini → ce handler exige un bearer en comparaison à TEMPS
//      CONSTANT (timingSafeEqual) ; fail-closed (absent/faux → 401). Prometheus
//      scrape avec `authorization`/`bearer_token_file`.
//  (B) METRICS_TOKEN absent → pas de régression : le contrôle par défaut reste le
//      network-scoping (ne pas router /metrics via l'entrée publique).
// Lit METRICS_TOKEN à l'enregistrement (comme le reste de la conf de boot).
export function registerPrometheusEndpoint(app: FastifyInstance): void {
  const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
  app.get("/metrics", async (request, reply) => {
    if (METRICS_TOKEN) {
      const header = request.headers.authorization || "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      const expected = Buffer.from(METRICS_TOKEN);
      const got = Buffer.from(presented);
      // Comparaison à temps constant ; le test de longueur est requis (timingSafeEqual
      // lève si les tailles diffèrent) et la longueur du token n'est pas un secret.
      const ok = got.length === expected.length && timingSafeEqual(got, expected);
      if (!ok) {
        return reply.code(401).send("Unauthorized");
      }
    }
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
}
