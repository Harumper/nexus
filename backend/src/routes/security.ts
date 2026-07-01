import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, getUserFromRequest } from "../middleware/auth.js";
import { dispatchAction } from "../services/action-dispatcher.js";

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  // Runs a Lynis audit ASYNCHRONOUSLY: we dispatch and immediately return the
  // request_id (no HTTP wait — Lynis takes 60-120s, which was causing
  // 504s behind the proxy). Progress is streamed via WS
  // (security.audit.progress) and the final result broadcast via WS
  // (security.audit.result) + persisted in handleActionResponse. RBAC enforced
  // by dispatchAction (security.audit is read-only -> allowed for READONLY+).
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

  // Scan history (for the trend curve). Most recent to oldest.
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
