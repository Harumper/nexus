import type { FastifyInstance } from "fastify";
import { requireAuth, requireAdmin, getUserFromRequest } from "../middleware/auth.js";
import { dispatchAction } from "../services/action-dispatcher.js";
import { waitForResponse } from "../services/action-response.js";
import { prisma } from "../services/database.js";
import { getConnectedMachineIds } from "../websocket/sessions.js";

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  // Dispatch an action and wait for response (synchronous)
  app.post(
    "/api/machines/:id/actions/sync",
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: "object",
          required: ["action_id"],
          properties: {
            action_id: { type: "string", minLength: 1 },
            params: { type: "object" },
            timeout: { type: "number", minimum: 1000, maximum: 120000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        action_id: string;
        params?: Record<string, unknown>;
        timeout?: number;
      };
      const user = getUserFromRequest(request);

      const result = await dispatchAction(id, body, user?.sub);

      if (!result.success || !result.requestId) {
        return reply.code(400).send({ error: result.error });
      }

      try {
        const data = await waitForResponse(
          result.requestId,
          body.timeout || 30_000
        );
        return reply.send({ success: true, data });
      } catch (err: any) {
        return reply.code(408).send({
          success: false,
          error: err.message || "Action timeout",
        });
      }
    }
  );

  // Dispatch an action to a single agent (async, fire-and-forget)
  app.post(
    "/api/machines/:id/actions",
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: "object",
          required: ["action_id"],
          properties: {
            action_id: { type: "string", minLength: 1 },
            params: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        action_id: string;
        params?: Record<string, unknown>;
      };
      const user = getUserFromRequest(request);

      const result = await dispatchAction(id, body, user?.sub);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      return reply.send({
        success: true,
        request_id: result.requestId,
        message: `Action '${body.action_id}' dispatched`,
      });
    }
  );

  // Batch action: dispatch to multiple machines at once
  app.post(
    "/api/machines/actions/batch",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["action_id"],
          properties: {
            action_id: { type: "string", minLength: 1 },
            machine_ids: {
              type: "array",
              items: { type: "string" },
            },
            params: { type: "object" },
            online_only: { type: "boolean", default: true },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        action_id: string;
        machine_ids?: string[];
        params?: Record<string, unknown>;
        online_only?: boolean;
      };
      const user = getUserFromRequest(request);

      // Déterminer les machines cibles
      let targetIds: string[];

      if (body.machine_ids && body.machine_ids.length > 0) {
        targetIds = body.machine_ids;
      } else {
        // Toutes les machines en ligne
        const connectedIds = getConnectedMachineIds();
        if (body.online_only !== false) {
          targetIds = connectedIds;
        } else {
          const allMachines = await prisma.machine.findMany({
            where: { status: { not: "REVOKED" } },
            select: { id: true },
          });
          targetIds = allMachines.map((m) => m.id);
        }
      }

      // Dispatcher en parallèle
      const results = await Promise.allSettled(
        targetIds.map(async (machineId) => {
          const result = await dispatchAction(
            machineId,
            { action_id: body.action_id, params: body.params },
            user?.sub
          );
          return { machineId, ...result };
        })
      );

      const dispatched: { machineId: string; requestId?: string }[] = [];
      const failed: { machineId: string; error: string }[] = [];

      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value.success) {
            dispatched.push({
              machineId: r.value.machineId,
              requestId: r.value.requestId,
            });
          } else {
            failed.push({
              machineId: r.value.machineId,
              error: r.value.error || "Unknown error",
            });
          }
        } else {
          failed.push({
            machineId: "unknown",
            error: r.reason?.message || "Dispatch failed",
          });
        }
      }

      return reply.send({
        success: true,
        action_id: body.action_id,
        total: targetIds.length,
        dispatched: dispatched.length,
        failed: failed.length,
        results: { dispatched, failed },
      });
    }
  );
}
