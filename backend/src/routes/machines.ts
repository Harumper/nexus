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
import { dispatchAgentUpgrade } from "../services/agent-upgrade.js";
import { isSudoersOutdated, getExpectedSudoersHash } from "../services/sudoers-version.js";

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
  // List machines (pagination optionnelle via ?limit=N&offset=M)
  // Cap de sécurité à 500 même sans pagination explicite pour éviter de
  // ramener 10 000 lignes si la fleet grossit.
  app.get(
    "/api/machines",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { limit, offset } = request.query as { limit?: string; offset?: string };
      const isPaginated = limit !== undefined;
      const take = Math.min(parseInt(limit ?? "500", 10) || 500, 500);
      const skip = parseInt(offset ?? "0", 10) || 0;

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
          type: true,
          isCritical: true,
          sudoersHash: true,
          lastHeartbeat: true,
          lastMetrics: true,
          enrolledAt: true,
          createdAt: true,
          tags: {
            include: { tag: true },
          },
        },
        take,
        skip,
        orderBy: { createdAt: "desc" },
      });

      const result = machines.map((m) => ({
        ...m,
        tags: m.tags.map((t) => t.tag),
        sudoersOutdated: isSudoersOutdated(m.sudoersHash),
      }));

      if (isPaginated) {
        const total = await prisma.machine.count();
        return reply.send({ machines: result, total, limit: take, offset: skip });
      }
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
          type: true,
          sshUser: true,
          isCritical: true,
          sudoersHash: true,
          boundIp: true,
          lastHeartbeat: true,
          lastMetrics: true,
          enrolledAt: true,
          createdAt: true,
          updatedAt: true,
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
        sudoersOutdated: isSudoersOutdated(machine.sudoersHash),
        expectedSudoersHash: getExpectedSudoersHash(),
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
            type: { type: "string", enum: ["AGENT", "PROBE"], default: "AGENT" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, type } = request.body as {
        name: string;
        type?: "AGENT" | "PROBE";
      };
      const user = getUserFromRequest(request);

      const result = await createMachineWithEnrollment(name, type || "AGENT");

      await logAudit({
        action: "MACHINE_CREATE",
        resource: "machine",
        resourceId: result.id,
        userId: user?.sub,
        ipAddress: request.ip,
        details: { name, type: type || "AGENT" },
      });

      // Generer les artifacts d'installation (binaire + script + commandes)
      const bootstrap = await buildBootstrapArtifacts(result);
      return reply.code(201).send({ ...result, bootstrap });
    }
  );

  // Mettre a jour les settings d'une machine (name, sshUser)
  app.patch(
    "/api/machines/:id",
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            sshUser: { type: ["string", "null"], maxLength: 64 },
            isCritical: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; sshUser?: string | null; isCritical?: boolean };
      const user = getUserFromRequest(request);

      // Validation sshUser : POSIX login name
      if (body.sshUser && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(body.sshUser)) {
        return reply.code(400).send({ error: "Invalid SSH username (POSIX login name required)" });
      }

      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.sshUser !== undefined) data.sshUser = body.sshUser || null;
      if (body.isCritical !== undefined) data.isCritical = body.isCritical;

      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: "No fields to update" });
      }

      try {
        const updated = await prisma.machine.update({
          where: { id },
          data,
          select: { id: true, name: true, sshUser: true, isCritical: true, type: true },
        });
        await logAudit({
          action: "MACHINE_UPDATE",
          resource: "machine",
          resourceId: id,
          userId: user?.sub,
          ipAddress: request.ip,
          details: { fields: Object.keys(data) },
        });
        return reply.send(updated);
      } catch (err: any) {
        if (err?.code === "P2025") {
          return reply.code(404).send({ error: "Machine not found" });
        }
        return reply.code(500).send({ error: "Failed to update machine" });
      }
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

      // Verifier que la machine existe
      const machine = await prisma.machine.findUnique({ where: { id }, select: { id: true } });
      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      // Deconnecter l'agent s'il est connecte
      disconnectAgent(id);

      try {
        await prisma.machine.delete({ where: { id } });
      } catch (err: any) {
        request.log.error({ err, machineId: id }, "[Machines] Delete failed");
        return reply.code(500).send({
          error: "Failed to delete machine",
          detail: err?.message || String(err),
        });
      }

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

  // Mettre à jour l'agent (self-upgrade vers le dernier binaire du backend)
  app.post(
    "/api/machines/:id/agent/upgrade",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      const result = await dispatchAgentUpgrade(id, user?.sub);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      await logAudit({
        action: "MACHINE_UPDATE",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        ipAddress: request.ip,
        details: { action: "agent_upgrade", previousVersion: result.currentVersion },
      });

      return reply.send({
        success: true,
        message: "Agent upgrade dispatched. Service will restart in ~2s.",
        request_id: result.requestId,
      });
    }
  );
}
