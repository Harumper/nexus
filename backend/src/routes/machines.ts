import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import {
  createMachineWithEnrollment,
  regenerateEnrollmentToken,
} from "../services/enrollment.js";
import { revokeMachine } from "../services/security.js";
import { disconnectAgent } from "../websocket/sessions.js";
import { requireAuth, requireAdmin, getUserFromRequest } from "../middleware/auth.js";
import { logAudit } from "../middleware/audit.js";
import { generateBootstrapToken, invalidateInstallTokens } from "../services/bootstrap.js";
import {
  generateInstallSteps,
  stepsToSingleCommand,
  getAgentBackendUrl,
  type BootstrapArtifacts,
} from "../services/agent-bootstrap.js";

interface MachineForBootstrap {
  id: string;
  name: string;
  enrollmentToken: string;
  backendPublicKey: string;
}

async function buildBootstrapArtifacts(
  machine: MachineForBootstrap
): Promise<BootstrapArtifacts | null> {
  let backendUrl: string;
  try {
    backendUrl = getAgentBackendUrl();
  } catch (err) {
    console.warn("[Bootstrap] AGENT_BACKEND_URL not configured — skipping install commands generation");
    return null;
  }

  const binaryTok = await generateBootstrapToken(machine.id, "install");
  const scriptTok = await generateBootstrapToken(machine.id, "install");

  const installSteps = generateInstallSteps({
    machineId: machine.id,
    machineName: machine.name,
    enrollmentToken: machine.enrollmentToken,
    backendPublicKey: machine.backendPublicKey,
    binaryToken: binaryTok.rawToken,
    scriptToken: scriptTok.rawToken,
    backendUrl,
  });

  // Les 2 tokens expirent au meme moment, on prend le plus tot
  const expiresAt = binaryTok.expiresAt < scriptTok.expiresAt ? binaryTok.expiresAt : scriptTok.expiresAt;

  return {
    installSteps,
    installCommand: stepsToSingleCommand(installSteps),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function machineRoutes(app: FastifyInstance): Promise<void> {
  // List all machines
  app.get(
    "/api/machines",
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const machines = await prisma.machine.findMany({
        select: {
          id: true,
          name: true,
          hostname: true,
          os: true,
          osVersion: true,
          arch: true,
          ipAddress: true,
          agentVersion: true,
          status: true,
          lastHeartbeat: true,
          lastMetrics: true,
          enrolledAt: true,
          createdAt: true,
          capabilities: {
            include: { capability: { select: { name: true } } },
          },
          tags: {
            include: { tag: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const result = machines.map((m) => ({
        ...m,
        capabilities: m.capabilities.map((c) => c.capability.name),
        tags: m.tags.map((t) => t.tag),
      }));

      return reply.send(result);
    }
  );

  // Get machine detail
  app.get(
    "/api/machines/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const machine = await prisma.machine.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          hostname: true,
          os: true,
          osVersion: true,
          arch: true,
          ipAddress: true,
          agentVersion: true,
          status: true,
          boundIp: true,
          lastHeartbeat: true,
          lastMetrics: true,
          enrolledAt: true,
          createdAt: true,
          updatedAt: true,
          capabilities: {
            include: { capability: { select: { id: true, name: true, description: true } } },
          },
          tags: {
            include: { tag: true },
          },
        },
      });

      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      return reply.send({
        ...machine,
        capabilities: machine.capabilities.map((c) => c.capability),
        tags: machine.tags.map((t) => t.tag),
      });
    }
  );

  // Create machine (with enrollment token)
  app.post(
    "/api/machines",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            capabilities: {
              type: "array",
              items: { type: "string" },
              default: ["monitoring"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, capabilities } = request.body as {
        name: string;
        capabilities?: string[];
      };
      const user = getUserFromRequest(request);

      const result = await createMachineWithEnrollment(
        name,
        capabilities || ["monitoring"]
      );

      await logAudit({
        action: "MACHINE_CREATE",
        resource: "machine",
        resourceId: result.id,
        userId: user?.sub,
        ipAddress: request.ip,
        details: { name, capabilities },
      });

      // Generer les artifacts d'installation (binaire + script + commandes)
      const bootstrap = await buildBootstrapArtifacts(result);
      return reply.code(201).send({ ...result, bootstrap });
    }
  );

  // Regenerer les tokens de bootstrap pour une machine existante
  app.post(
    "/api/machines/:id/bootstrap/regenerate",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      const machine = await prisma.machine.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          enrollmentToken: true,
          backendPublicKey: true,
        },
      });

      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      if (!machine.enrollmentToken) {
        return reply.code(400).send({
          error: "Machine is already enrolled. Use POST /re-enroll to regenerate the enrollment token.",
        });
      }

      if (!machine.backendPublicKey) {
        return reply.code(500).send({ error: "Machine has no backend public key" });
      }

      // Invalider tous les tokens install existants
      await invalidateInstallTokens(id);

      const bootstrap = await buildBootstrapArtifacts({
        id: machine.id,
        name: machine.name,
        enrollmentToken: machine.enrollmentToken,
        backendPublicKey: machine.backendPublicKey,
      });

      await logAudit({
        action: "MACHINE_UPDATE",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        ipAddress: request.ip,
        details: { action: "bootstrap_regenerated" },
      });

      return reply.send(bootstrap);
    }
  );

  // Delete machine
  app.delete(
    "/api/machines/:id",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      // Déconnecter l'agent s'il est connecté
      disconnectAgent(id);

      await prisma.machine.delete({ where: { id } });

      await logAudit({
        action: "MACHINE_DELETE",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        ipAddress: request.ip,
      });

      return reply.code(204).send();
    }
  );

  // Revoke machine (security action)
  app.post(
    "/api/machines/:id/revoke",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            reason: { type: "string", default: "Manual revocation" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { reason } = (request.body as { reason?: string }) || {};
      const user = getUserFromRequest(request);

      // Révoquer les clés
      await revokeMachine(id, reason || "Manual revocation", user?.sub);

      // Déconnecter l'agent immédiatement
      disconnectAgent(id);

      return reply.send({ success: true, message: "Machine revoked and disconnected" });
    }
  );

  // Re-enroll machine
  app.post(
    "/api/machines/:id/re-enroll",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const result = await regenerateEnrollmentToken(id);

      return reply.send(result);
    }
  );
}
