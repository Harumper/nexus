import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth } from "../middleware/auth.js";

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // Get metrics for a machine
  app.get(
    "/api/machines/:id/metrics",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { range = "1h" } = request.query as { range?: string };

      // Window + bucket size per range. The bucket DOWNSAMPLES the series in SQL
      // (avg per slice) to target ~120-170 points regardless of the window:
      // this way the view covers the ENTIRE requested range (no more "100 oldest
      // points" that showed 1h40 from 24h ago). 15m/1h = 60s bucket = native
      // collection resolution → no loss. bucketSeconds comes from a hard-coded MAP
      // (no free input → safe to inject into the SQL).
      const RANGES: Record<string, { ms: number; bucketSec: number }> = {
        "15m": { ms: 15 * 60 * 1000, bucketSec: 60 },
        "1h": { ms: 60 * 60 * 1000, bucketSec: 60 },
        "6h": { ms: 6 * 60 * 60 * 1000, bucketSec: 180 },
        "24h": { ms: 24 * 60 * 60 * 1000, bucketSec: 600 },
        "7d": { ms: 7 * 24 * 60 * 60 * 1000, bucketSec: 3600 },
        "30d": { ms: 30 * 24 * 60 * 60 * 1000, bucketSec: 21600 },
      };
      const cfg = RANGES[range] ?? RANGES["1h"];
      const bucketSec = cfg.bucketSec;
      const since = new Date(Date.now() - cfg.ms);

      // Downsampling in SQL (same engine as /fleet/trends). Bucket aligned on
      // floor(epoch/bucket)*bucket → STABLE buckets (reused by the front-end
      // gap-fill and Compare's multi-machine merge). disk/network are
      // in JSON: we extract [0] (the 1st entry, like the display), uptime
      // as max (monotonic counter: avg would make no sense).
      const rows = await prisma.$queryRaw<
        Array<{
          bucket: Date;
          cpu: number | null;
          mem: number | null;
          memused: number | null;
          memtotal: number | null;
          load: number | null;
          disk: number | null;
          rx: number | null;
          tx: number | null;
          uptime: number | null;
        }>
      >`
        SELECT
          to_timestamp(floor(extract(epoch from "timestamp") / ${bucketSec}::int) * ${bucketSec}::int) AS bucket,
          round(avg("cpuPercent")::numeric, 2)::float8                       AS cpu,
          round(avg("memoryPercent")::numeric, 2)::float8                    AS mem,
          avg("memoryUsed")::float8                                          AS memused,
          avg("memoryTotal")::float8                                         AS memtotal,
          round(avg("loadAvg1")::numeric, 2)::float8                         AS load,
          round(avg(("disks"->0->>'percent')::numeric), 2)::float8           AS disk,
          avg(("network"->0->>'rx_bytes_per_sec')::float8)                   AS rx,
          avg(("network"->0->>'tx_bytes_per_sec')::float8)                   AS tx,
          max("uptime")::float8                                              AS uptime
        FROM "Metric"
        WHERE "machineId" = ${id} AND "timestamp" >= ${since}
        GROUP BY bucket
        ORDER BY bucket ASC
      `;

      // Rebuilds the Metric shape expected by the frontend (disks/network as a
      // 1-entry aggregated array — the graph only reads [0]).
      const result = rows.map((r) => ({
        id: r.bucket.toISOString(),
        cpuPercent: r.cpu ?? 0,
        memoryPercent: r.mem ?? 0,
        memoryUsed: r.memused != null ? Math.round(r.memused) : 0,
        memoryTotal: r.memtotal != null ? Math.round(r.memtotal) : 0,
        loadAvg1: r.load,
        loadAvg5: null,
        loadAvg15: null,
        disks: r.disk != null ? [{ percent: r.disk }] : [],
        network:
          r.rx != null || r.tx != null
            ? [{ rx_bytes_per_sec: r.rx ?? 0, tx_bytes_per_sec: r.tx ?? 0 }]
            : [],
        uptime: r.uptime != null ? Math.round(r.uptime) : null,
        timestamp: r.bucket.toISOString(),
      }));

      return reply.send({
        machineId: id,
        range,
        bucketSeconds: bucketSec,
        since: since.toISOString(),
        count: result.length,
        metrics: result,
      });
    }
  );

  // Get latest metrics for a machine
  app.get(
    "/api/machines/:id/metrics/latest",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const metric = await prisma.metric.findFirst({
        where: { machineId: id },
        orderBy: { timestamp: "desc" },
      });

      if (!metric) {
        return reply.code(404).send({ error: "No metrics found" });
      }

      return reply.send({
        ...metric,
        memoryUsed: Number(metric.memoryUsed),
        memoryTotal: Number(metric.memoryTotal),
        uptime: metric.uptime ? Number(metric.uptime) : null,
      });
    }
  );
}
