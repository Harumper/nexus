import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth } from "../middleware/auth.js";
import { getFleetLatest, getFleetSeries, liveWindow } from "../services/metrics-buffer.js";

export async function fleetRoutes(app: FastifyInstance) {
  // GET /api/fleet/summary — instantaneous aggregate across online machines, from the
  // live in-memory buffer (latest point per machine). No history here — that's
  // Prometheus/Grafana (the old /fleet/trends endpoint was removed with the DB table).
  app.get("/api/fleet/summary", { preHandler: [requireAuth] }, async (request, reply) => {
    const machines = await prisma.machine.findMany({
      where: { status: "ONLINE" },
      select: { id: true, name: true, rebootRequired: true },
    });
    const machineMap = new Map(machines.map(m => [m.id, m.name]));

    // Latest live point per ONLINE machine.
    const fleetLatest = getFleetLatest();
    const validMetrics = machines
      .map(m => {
        const p = fleetLatest.get(m.id);
        return p ? { machineId: m.id, ...p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const diskPercent = (m: { disks: unknown }): number => {
      const disks = m.disks as any[];
      return Array.isArray(disks) && disks.length > 0 ? disks[0].percent ?? 0 : 0;
    };

    // Averages
    const avgCpu = validMetrics.length > 0
      ? validMetrics.reduce((sum, m) => sum + m.cpuPercent, 0) / validMetrics.length : 0;
    const avgMemory = validMetrics.length > 0
      ? validMetrics.reduce((sum, m) => sum + m.memoryPercent, 0) / validMetrics.length : 0;
    const avgDisk = validMetrics.length > 0
      ? validMetrics.reduce((sum, m) => sum + diskPercent(m), 0) / validMetrics.length : 0;

    // Top 5 consumers
    const topCpu = [...validMetrics]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 5)
      .map(m => ({ machineId: m.machineId, name: machineMap.get(m.machineId), value: m.cpuPercent }));
    const topMemory = [...validMetrics]
      .sort((a, b) => b.memoryPercent - a.memoryPercent)
      .slice(0, 5)
      .map(m => ({ machineId: m.machineId, name: machineMap.get(m.machineId), value: m.memoryPercent }));
    const topDisk = [...validMetrics]
      .sort((a, b) => diskPercent(b) - diskPercent(a))
      .slice(0, 5)
      .map(m => ({ machineId: m.machineId, name: machineMap.get(m.machineId), value: diskPercent(m) }));

    // Health score — pre-load all thresholds in one query
    const thresholdSettings = await prisma.setting.findMany({
      where: { key: { in: ["health_threshold_cpu", "health_threshold_memory", "health_threshold_disk"] } },
    });
    const settingMap = new Map(thresholdSettings.map(s => [s.key, s.value]));
    const getThreshold = (key: string, def: number) => {
      const v = settingMap.get(key);
      const n = typeof v === "number" ? v : (v as any)?.value ?? v;
      return typeof n === "number" ? n : def;
    };
    const cpuThreshold = getThreshold("health_threshold_cpu", 90);
    const memThreshold = getThreshold("health_threshold_memory", 85);
    const diskThreshold = getThreshold("health_threshold_disk", 80);

    const healthyCount = validMetrics.filter(m => {
      const disks = m.disks as any[];
      const diskOk = !Array.isArray(disks) || disks.every((d: any) => d.percent < diskThreshold);
      return m.cpuPercent < cpuThreshold && m.memoryPercent < memThreshold && diskOk;
    }).length;
    const healthScore = machines.length > 0 ? Math.round((healthyCount / machines.length) * 100) : 100;

    // Counts
    const allMachines = await prisma.machine.count();
    const onlineCount = machines.length;
    const alertCount = await prisma.alertState.count({ where: { status: "FIRING" } });
    const rebootCount = machines.filter(m => m.rebootRequired).length;

    return {
      avgCpu: Math.round(avgCpu * 10) / 10,
      avgMemory: Math.round(avgMemory * 10) / 10,
      avgDisk: Math.round(avgDisk * 10) / 10,
      topCpu,
      topMemory,
      topDisk,
      healthScore,
      machineCount: allMachines,
      onlineCount,
      alertCount,
      rebootCount,
    };
  });

  // GET /api/fleet/live — small live fleet trend (avg cpu/memory per bucket) over the
  // ~30 min window, aggregated from the in-memory buffer. Feeds the Dashboard mini-charts.
  // (Long-term history stays in Prometheus/Grafana; the old persisted /fleet/trends is gone.)
  app.get("/api/fleet/live", { preHandler: [requireAuth] }, async () => {
    const w = liveWindow();
    return { bucketSeconds: w.bucketSeconds, since: w.since, series: getFleetSeries() };
  });
}
