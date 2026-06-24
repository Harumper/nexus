import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, getUserFromRequest } from "../middleware/auth.js";
import { dispatchAction } from "../services/action-dispatcher.js";
import { waitForResponse } from "../services/action-response.js";

// Résultat brut renvoyé par l'action agent security.audit.
interface AuditData {
  hardening_index?: number;
  warning_count?: number;
  suggestion_count?: number;
  lynis_version?: string;
  fail2ban_active?: boolean;
  auto_updates_active?: boolean;
  ssh_hardened?: boolean;
  firewall_active?: boolean;
  [k: string]: unknown;
}

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  // Lance un audit Lynis ET persiste un SecurityScan (historique/tendance).
  // Lecture seule côté machine ; RBAC appliqué par dispatchAction (security.audit
  // est read-only -> autorisé READONLY+).
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

      let data: AuditData;
      try {
        data = (await waitForResponse(result.requestId, 120_000)) as AuditData;
      } catch (err: any) {
        return reply.code(408).send({ success: false, error: err?.message || "Audit timeout" });
      }

      // Persiste un point d'historique (résumé ; les listes restent dans `data`).
      try {
        await prisma.securityScan.create({
          data: {
            machineId: id,
            hardeningIndex:
              typeof data.hardening_index === "number" ? data.hardening_index : -1,
            warningCount: data.warning_count ?? 0,
            suggestionCount: data.suggestion_count ?? 0,
            lynisVersion: data.lynis_version || null,
            fail2banActive: !!data.fail2ban_active,
            autoUpdatesActive: !!data.auto_updates_active,
            sshHardened: !!data.ssh_hardened,
            firewallActive: !!data.firewall_active,
          },
        });
      } catch (err) {
        request.log.error({ err, machineId: id }, "[Security] persist scan failed");
        // On ne fait pas échouer l'audit si la persistance échoue.
      }

      return reply.send({ success: true, data });
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
