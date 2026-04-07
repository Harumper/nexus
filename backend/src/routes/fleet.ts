import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth } from "../middleware/auth.js";

export async function fleetRoutes(app: FastifyInstance) {
  // GET /api/fleet/summary — Aggregated metrics across all online machines
  app.get("/api/fleet/summary", { preHandler: [requireAuth] }, async (request, reply) => {
    // Get all online machines
    const machines = await prisma.machine.findMany({
      where: { status: "ONLINE" },
      select: { id: true, name: true, rebootRequired: true },
    });
    const machineIds = machines.map(m => m.id);
    const machineMap = new Map(machines.map(m => [m.id, m.name]));

    // Single query : latest metric per machine via raw SQL (DISTINCT ON)
    const validMetrics: any[] = machineIds.length > 0
      ? await prisma.$queryRawUnsafe(`
          SELECT DISTINCT ON ("machineId")
            "machineId", "cpuPercent", "memoryPercent", "memoryUsed", "memoryTotal",
            "disks", "loadAvg1", "uptime", "timestamp"
          FROM "Metric"
          WHERE "machineId" = ANY($1::text[])
          ORDER BY "machineId", "timestamp" DESC
        `, machineIds)
      : [];

    // Calculate averages
    const avgCpu = validMetrics.length > 0
      ? validMetrics.reduce((sum, m) => sum + m.cpuPercent, 0) / validMetrics.length : 0;
    const avgMemory = validMetrics.length > 0
      ? validMetrics.reduce((sum, m) => sum + m.memoryPercent, 0) / validMetrics.length : 0;
    const avgDisk = validMetrics.length > 0
      ? validMetrics.reduce((sum, m) => {
          const disks = m.disks as any[];
          const primaryDisk = Array.isArray(disks) && disks.length > 0 ? disks[0].percent : 0;
          return sum + primaryDisk;
        }, 0) / validMetrics.length : 0;

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
      .sort((a, b) => {
        const aDisks = a.disks as any[];
        const bDisks = b.disks as any[];
        return (Array.isArray(bDisks) && bDisks[0]?.percent || 0) - (Array.isArray(aDisks) && aDisks[0]?.percent || 0);
      })
      .slice(0, 5)
      .map(m => {
        const disks = m.disks as any[];
        return { machineId: m.machineId, name: machineMap.get(m.machineId), value: Array.isArray(disks) && disks[0]?.percent || 0 };
      });

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

  // GET /api/fleet/trends?range=1h — Aggregated metrics over time in 5-min buckets
  app.get("/api/fleet/trends", { preHandler: [requireAuth] }, async (request, reply) => {
    const { range = "1h" } = request.query as { range?: string };

    const rangeMs: Record<string, number> = {
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
    };
    const ms = rangeMs[range] || rangeMs["1h"];
    const since = new Date(Date.now() - ms);
    const bucketSize = 5 * 60 * 1000; // 5 minutes

    const metrics = await prisma.metric.findMany({
      where: { timestamp: { gte: since } },
      orderBy: { timestamp: "asc" },
      select: { cpuPercent: true, memoryPercent: true, timestamp: true },
    });

    // Group by 5-min buckets
    const buckets = new Map<number, { cpuSum: number; memSum: number; count: number }>();
    for (const m of metrics) {
      const bucketKey = Math.floor(m.timestamp.getTime() / bucketSize) * bucketSize;
      const existing = buckets.get(bucketKey) || { cpuSum: 0, memSum: 0, count: 0 };
      existing.cpuSum += m.cpuPercent;
      existing.memSum += m.memoryPercent;
      existing.count++;
      buckets.set(bucketKey, existing);
    }

    const result = Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([timestamp, data]) => ({
        timestamp: new Date(timestamp).toISOString(),
        avgCpu: Math.round((data.cpuSum / data.count) * 10) / 10,
        avgMemory: Math.round((data.memSum / data.count) * 10) / 10,
      }));

    return { range, buckets: result };
  });
}

async function getSettingValue(key: string, defaultValue: number): Promise<number> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  if (!setting) return defaultValue;
  const val = typeof setting.value === "number" ? setting.value : (setting.value as any)?.value ?? (setting.value as any);
  return typeof val === "number" ? val : defaultValue;
}
