import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAdmin, getUserFromRequest } from "../middleware/auth.js";
import { logAudit } from "../middleware/audit.js";
import { dispatchAction } from "../services/action-dispatcher.js";
import { waitForResponse } from "../services/action-response.js";
import { getAgentSession } from "../websocket/sessions.js";

// Actions autorisees en bulk. On exclut les actions watchdog-revert (netplan,
// firewall) car elles necessitent confirmation individuelle.
const BULK_ALLOWED_ACTIONS = new Set([
  "system.reboot",
  "system.update",
  "system.update_security",
  "system.service_start",
  "system.service_stop",
  "system.service_restart",
  "agent.upgrade",
  "package.install",
  "package.remove",
  "package.hold",
  "package.unhold",
  "script.execute",
]);

export async function bulkRoutes(app: FastifyInstance): Promise<void> {
  // Dispatch une action sur plusieurs machines en parallele
  app.post(
    "/api/bulk/dispatch",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["action_id"],
          properties: {
            action_id: { type: "string", minLength: 1 },
            params: { type: "object" },
            machineIds: { type: "array", items: { type: "string" } },
            groupId: { type: "string" },
            mode: { type: "string", enum: ["sync", "fire"], default: "sync" },
            timeout: { type: "number", minimum: 1000, maximum: 120000, default: 30000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        action_id: string;
        params?: Record<string, unknown>;
        machineIds?: string[];
        groupId?: string;
        mode?: "sync" | "fire";
        timeout?: number;
      };
      const user = getUserFromRequest(request);

      if (!BULK_ALLOWED_ACTIONS.has(body.action_id)) {
        return reply.code(400).send({
          error: `Action '${body.action_id}' not allowed for bulk dispatch`,
        });
      }

      // Resolver la liste de machines cibles
      let targetIds: string[] = [];
      if (body.machineIds && body.machineIds.length > 0) {
        targetIds = body.machineIds;
      } else if (body.groupId) {
        const members = await prisma.machineGroupMember.findMany({
          where: { groupId: body.groupId },
          select: { machineId: true },
        });
        targetIds = members.map((m) => m.machineId);
      } else {
        return reply.code(400).send({ error: "machineIds or groupId required" });
      }

      if (targetIds.length === 0) {
        return reply.code(400).send({ error: "No machines selected" });
      }

      if (targetIds.length > 100) {
        return reply.code(400).send({ error: "Cannot target more than 100 machines at once" });
      }

      // Filtrer les machines offline
      const machines = await prisma.machine.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, name: true, status: true, isCritical: true },
      });

      const mode = body.mode || "sync";
      const timeout = body.timeout || 30_000;

      // Dispatch en parallele avec concurrence limitee a 10
      const concurrency = 10;
      const results: any[] = [];

      const runOne = async (machine: { id: string; name: string; status: string }) => {
        if (machine.status !== "ONLINE") {
          return {
            machineId: machine.id,
            machineName: machine.name,
            success: false,
            error: `Machine is ${machine.status}`,
            skipped: true,
          };
        }
        const session = getAgentSession(machine.id);
        if (!session?.authenticated) {
          return {
            machineId: machine.id,
            machineName: machine.name,
            success: false,
            error: "Agent not connected",
            skipped: true,
          };
        }
        try {
          const dispatch = await dispatchAction(
            machine.id,
            { action_id: body.action_id, params: body.params },
            user?.sub,
            user?.role
          );
          if (!dispatch.success || !dispatch.requestId) {
            return {
              machineId: machine.id,
              machineName: machine.name,
              success: false,
              error: dispatch.error || "dispatch failed",
            };
          }
          if (mode === "fire") {
            return {
              machineId: machine.id,
              machineName: machine.name,
              success: true,
              requestId: dispatch.requestId,
              async: true,
            };
          }
          // Mode sync : attendre la reponse
          const data = await waitForResponse(dispatch.requestId, timeout);
          return {
            machineId: machine.id,
            machineName: machine.name,
            success: true,
            requestId: dispatch.requestId,
            data,
          };
        } catch (err: any) {
          return {
            machineId: machine.id,
            machineName: machine.name,
            success: false,
            error: err?.message || "unknown error",
          };
        }
      };

      for (let i = 0; i < machines.length; i += concurrency) {
        const batch = machines.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(runOne));
        results.push(...batchResults);
      }

      const summary = {
        total: results.length,
        success: results.filter((r) => r.success && !r.skipped).length,
        failed: results.filter((r) => !r.success && !r.skipped).length,
        skipped: results.filter((r) => r.skipped).length,
      };

      await logAudit({
        action: "ACTION_REQUEST",
        resource: "bulk",
        userId: user?.sub,
        ipAddress: request.ip,
        details: {
          action_id: body.action_id,
          machineCount: targetIds.length,
          mode,
          summary,
        },
      });

      return reply.send({
        success: true,
        action_id: body.action_id,
        mode,
        summary,
        results,
      });
    }
  );
}
