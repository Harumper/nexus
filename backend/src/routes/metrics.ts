import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { getSeries, getLatest, liveWindow } from "../services/metrics-buffer.js";

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // Live metrics series for a machine (in-memory window; ~last 30 min). Long-term
  // history is Prometheus/Grafana — this is only the live view. The `range` query is
  // accepted but ignored (kept for backward compatibility during the frontend switch).
  app.get(
    "/api/machines/:id/metrics",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const w = liveWindow();
      const metrics = getSeries(id);
      return reply.send({
        machineId: id,
        bucketSeconds: w.bucketSeconds,
        since: w.since,
        count: metrics.length,
        metrics,
      });
    }
  );

  // Latest live point for a machine (or 404 if it has not reported within the window,
  // e.g. shortly after a backend restart).
  app.get(
    "/api/machines/:id/metrics/latest",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const metric = getLatest(id);
      if (!metric) {
        return reply.code(404).send({ error: "No metrics found" });
      }
      return reply.send(metric);
    }
  );
}
