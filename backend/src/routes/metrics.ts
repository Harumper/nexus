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
      const { range = "1h", limit = "100" } = request.query as {
        range?: string;
        limit?: string;
      };

      // Calculer la date de début selon le range
      const now = new Date();
      let since: Date;

      switch (range) {
        case "15m":
          since = new Date(now.getTime() - 15 * 60 * 1000);
          break;
        case "1h":
          since = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case "6h":
          since = new Date(now.getTime() - 6 * 60 * 60 * 1000);
          break;
        case "24h":
          since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case "7d":
          since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "30d":
          since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          since = new Date(now.getTime() - 60 * 60 * 1000);
      }

      const metrics = await prisma.metric.findMany({
        where: {
          machineId: id,
          timestamp: { gte: since },
        },
        orderBy: { timestamp: "asc" },
        take: parseInt(limit, 10),
        select: {
          id: true,
          cpuPercent: true,
          memoryUsed: true,
          memoryTotal: true,
          memoryPercent: true,
          disks: true,
          network: true,
          loadAvg1: true,
          loadAvg5: true,
          loadAvg15: true,
          uptime: true,
          timestamp: true,
        },
      });

      // Convertir BigInt en number pour la sérialisation JSON
      const result = metrics.map((m) => ({
        ...m,
        memoryUsed: Number(m.memoryUsed),
        memoryTotal: Number(m.memoryTotal),
        uptime: m.uptime ? Number(m.uptime) : null,
      }));

      return reply.send({
        machineId: id,
        range,
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
