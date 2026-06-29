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

      // Fenêtre + taille de bucket par range. Le bucket DOWNSAMPLE la série en SQL
      // (avg par tranche) pour viser ~120-170 points quelle que soit la fenêtre :
      // ainsi la vue couvre TOUT le range demandé (fini le « 100 points les plus
      // anciens » qui montrait 1h40 d'il y a 24h). 15m/1h = bucket 60s = résolution
      // de collecte native → aucune perte. bucketSeconds vient d'une MAP en dur
      // (pas d'input libre → sûr à injecter dans le SQL).
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

      // Downsampling en SQL (même moteur que /fleet/trends). Bucket aligné sur
      // floor(epoch/bucket)*bucket → des buckets STABLES (réutilisés par le
      // gap-fill front et la fusion multi-machines de Compare). disque/réseau
      // sont en JSON : on extrait [0] (la 1re entrée, comme l'affichage), uptime
      // en max (compteur croissant : avg n'aurait pas de sens).
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

      // Reconstruit le shape Metric attendu par le frontend (disks/network en
      // tableau à 1 entrée agrégée — le graphe ne lit que [0]).
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
