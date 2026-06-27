import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAdmin, getUserFromRequest } from "../middleware/auth.js";
import { logAudit } from "../middleware/audit.js";
import { getAgentSession } from "../websocket/sessions.js";
import { PROTOCOL_VERSION } from "../websocket/protocol.js";
import {
  signPayload,
  buildSignaturePayload,
  generateNonce,
  decryptPrivateKey,
} from "../services/crypto.js";

export async function networkRoutes(app: FastifyInstance): Promise<void> {
  // Confirme une modification netplan en attente (annule le watchdog-revert 120s)
  app.post(
    "/api/machines/:id/netplan/confirm",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["request_id"],
          properties: {
            request_id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { request_id } = request.body as { request_id: string };
      const user = getUserFromRequest(request);

      const session = getAgentSession(id);
      if (!session?.authenticated) {
        return reply.code(400).send({ error: "Agent is not connected" });
      }

      const machine = await prisma.machine.findUnique({
        where: { id },
        select: { backendPrivateKey: true },
      });
      if (!machine?.backendPrivateKey) {
        return reply.code(500).send({ error: "Machine has no backend key" });
      }

      const nonce = generateNonce();
      const timestamp = new Date().toISOString();
      const payload = JSON.stringify({ request_id });

      const sigPayload = buildSignaturePayload({
        v: PROTOCOL_VERSION,
        type: "action.confirm",
        request_id,
        machine_id: id,
        timestamp,
        nonce,
        payload,
      });

      const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey);
      const signature = signPayload(sigPayload, backendPrivateKey);

      session.ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "action.confirm",
          request_id,
          machine_id: id,
          timestamp,
          nonce,
          payload,
          signature,
        })
      );

      await logAudit({
        action: "ACTION_COMPLETE",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        machineId: id,
        ipAddress: request.ip,
        details: { action: "netplan_confirm", request_id },
      });

      return reply.send({ success: true, message: "Netplan confirmation sent to agent" });
    }
  );
}
