import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, getUserFromRequest } from "../middleware/auth.js";
import { dispatchAction } from "../services/action-dispatcher.js";

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  // Lance un audit Lynis en ASYNCHRONE : on dispatche et on renvoie aussitôt le
  // request_id (pas d'attente HTTP — Lynis dure 60-120s, ce qui provoquait des
  // 504 derrière le proxy). La progression est streamée via WS
  // (security.audit.progress) et le résultat final diffusé via WS
  // (security.audit.result) + persisté dans handleActionResponse. RBAC appliqué
  // par dispatchAction (security.audit est read-only -> autorisé READONLY+).
  app.post(
    "/api/machines/:id/security/audit",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      const result = await dispatchAction(
        id,
        { action_id: "security.audit", params: {} },
        user?.sub,
        user?.role
      );
      if (!result.success || !result.requestId) {
        return reply.code(400).send({ error: result.error });
      }

      return reply.send({ success: true, request_id: result.requestId });
    }
  );

  // Historique des scans (pour la courbe de tendance). Du plus récent au plus ancien.
  app.get(
    "/api/machines/:id/security/scans",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };
      const take = Math.min(parseInt(limit ?? "50", 10) || 50, 200);

      const scans = await prisma.securityScan.findMany({
        where: { machineId: id },
        orderBy: { scannedAt: "desc" },
        take,
        select: {
          hardeningIndex: true,
          warningCount: true,
          suggestionCount: true,
          fail2banActive: true,
          autoUpdatesActive: true,
          sshHardened: true,
          firewallActive: true,
          scannedAt: true,
        },
      });

      return reply.send({ scans });
    }
  );
}
