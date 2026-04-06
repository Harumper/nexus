import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import { requireAuth, requireAdmin, getUserFromRequest } from "../middleware/auth.js";
import { logAudit } from "../middleware/audit.js";
import { getAgentSession } from "../websocket/sessions.js";
import { getMachineCapabilities } from "../services/machine-manager.js";

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  // List all capabilities
  app.get(
    "/api/capabilities",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const capabilities = await prisma.capability.findMany({
        orderBy: { name: "asc" },
      });
      return reply.send(capabilities);
    }
  );

  // Assign capability to machine
  app.post(
    "/api/machines/:id/capabilities",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["capability_name"],
          properties: {
            capability_name: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { capability_name } = request.body as { capability_name: string };
      const user = getUserFromRequest(request);

      const capability = await prisma.capability.findUnique({
        where: { name: capability_name },
      });

      if (!capability) {
        return reply.code(404).send({ error: "Capability not found" });
      }

      // Vérifier si déjà assignée
      const existing = await prisma.machineCapability.findUnique({
        where: {
          machineId_capabilityId: {
            machineId: id,
            capabilityId: capability.id,
          },
        },
      });

      if (existing) {
        return reply.code(409).send({ error: "Capability already assigned" });
      }

      await prisma.machineCapability.create({
        data: {
          machineId: id,
          capabilityId: capability.id,
          grantedBy: user?.sub,
        },
      });

      await logAudit({
        action: "CAPABILITY_GRANT",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        machineId: id,
        details: { capability: capability_name },
      });

      // Notifier l'agent si connecté
      await notifyCapabilitiesUpdate(id);

      return reply.code(201).send({ success: true, capability: capability_name });
    }
  );

  // Remove capability from machine
  app.delete(
    "/api/machines/:id/capabilities/:capId",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id, capId } = request.params as { id: string; capId: string };
      const user = getUserFromRequest(request);

      const mc = await prisma.machineCapability.findFirst({
        where: { machineId: id, capabilityId: capId },
        include: { capability: true },
      });

      if (!mc) {
        return reply.code(404).send({ error: "Capability assignment not found" });
      }

      await prisma.machineCapability.delete({ where: { id: mc.id } });

      await logAudit({
        action: "CAPABILITY_REVOKE",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        machineId: id,
        details: { capability: mc.capability.name },
      });

      // Notifier l'agent
      await notifyCapabilitiesUpdate(id);

      return reply.code(204).send();
    }
  );
}

async function notifyCapabilitiesUpdate(machineId: string): Promise<void> {
  const session = getAgentSession(machineId);
  if (!session?.authenticated) return;

  const capabilities = await getMachineCapabilities(machineId);

  // Envoyer la mise à jour (non chiffré pour simplifier, l'agent vérifiera)
  session.ws.send(
    JSON.stringify({
      type: "capabilities.update",
      machine_id: machineId,
      capabilities,
    })
  );
}
