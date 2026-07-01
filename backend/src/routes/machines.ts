import type { FastifyInstance } from "fastify";
import { prisma } from "../services/database.js";
import {
  createMachineWithEnrollment,
  regenerateEnrollmentToken,
} from "../services/enrollment.js";
import { revokeMachine } from "../services/security.js";
import { disconnectAgent, getAgentSession, getConnectedMachineIds } from "../websocket/sessions.js";
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
import {
  getServerBinarySHA256,
  getServerAgentVersion,
  computeAgentUpdateAvailable,
  getLatestAgentSha,
  isUpgradePending,
} from "../services/agent-upgrade-tracker.js";
import { isSudoersOutdated, getExpectedSudoersHash } from "../services/sudoers-version.js";

interface MachineForBootstrap {
  id: string;
  name: string;
  enrollmentToken: string;
  backendPublicKey: string;
}

async function buildBootstrapArtifacts(
  machine: MachineForBootstrap,
  opts: { reenroll?: boolean } = {}
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
    reenroll: opts.reenroll,
  });

  // Both tokens expire at the same time; take the earliest
  const expiresAt = binaryTok.expiresAt < scriptTok.expiresAt ? binaryTok.expiresAt : scriptTok.expiresAt;

  return {
    installSteps,
    installCommand: stepsToSingleCommand(installSteps),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function machineRoutes(app: FastifyInstance): Promise<void> {
  // List machines (optional pagination via ?limit=N&offset=M)
  // Safety cap at 500 even without explicit pagination, to avoid pulling
  // 10,000 rows if the fleet grows.
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
          isCritical: true,
          sudoersHash: true,
          agentSha256: true,
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

      // Live WS presence — distinct from the DB status, which has a 90s grace
      // period after disconnect (anti-flapping, see handler.ts:126). The frontend
      // uses isConnected to know whether a dispatched action will go through.
      const connectedIds = new Set(getConnectedMachineIds());
      // Served target: version (preferred) + SHA (fallback) — computed once.
      const servedVersion = getServerAgentVersion();
      const targetSha = await getServerBinarySHA256();

      const result = machines.map((m) => {
        const { agentSha256, ...rest } = m;
        return {
          ...rest,
          tags: m.tags.map((t) => t.tag),
          sudoersOutdated: isSudoersOutdated(m.sudoersHash),
          isConnected: connectedIds.has(m.id),
          // Agent update available = served version ≠ current version; ignore the
          // build sha so we don't flag it on every commit.
          agentUpdateAvailable: computeAgentUpdateAvailable(
            servedVersion,
            targetSha,
            m.agentVersion,
            agentSha256
          ),
        };
      });

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
          sshUser: true,
          isCritical: true,
          sudoersHash: true,
          agentSha256: true,
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

      const servedVersion = getServerAgentVersion();
      const targetSha = await getServerBinarySHA256();
      const { agentSha256, ...machineRest } = machine;

      return reply.send({
        ...machineRest,
        sudoersOutdated: isSudoersOutdated(machine.sudoersHash),
        expectedSudoersHash: getExpectedSudoersHash(),
        tags: machine.tags.map((t) => t.tag),
        // Live WS presence — see route /api/machines for the rationale
        isConnected: getAgentSession(id)?.authenticated === true,
        // Update by version comparison (ignores the build sha) — see list.
        agentUpdateAvailable: computeAgentUpdateAvailable(
          servedVersion,
          targetSha,
          machine.agentVersion,
          agentSha256
        ),
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
          },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.body as { name: string };
      const user = getUserFromRequest(request);

      const result = await createMachineWithEnrollment(name);

      await logAudit({
        action: "MACHINE_CREATE",
        resource: "machine",
        resourceId: result.id,
        userId: user?.sub,
        ipAddress: request.ip,
        details: { name },
      });

      // Generate the install artifacts (binary + script + commands)
      const bootstrap = await buildBootstrapArtifacts(result);
      return reply.code(201).send({ ...result, bootstrap });
    }
  );

  // Update a machine's settings (name, sshUser)
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

      // sshUser validation: POSIX login name
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
          select: { id: true, name: true, sshUser: true, isCritical: true },
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

  // Regenerate the bootstrap tokens for an existing machine
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

      // Invalidate all existing install tokens
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

      // Verify that the machine exists
      const machine = await prisma.machine.findUnique({ where: { id }, select: { id: true } });
      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      // Disconnect the agent if it is connected
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

      // Revoke the keys
      await revokeMachine(id, reason || "Manual revocation", user?.sub);

      // Disconnect the agent immediately
      disconnectAgent(id);

      return reply.send({ success: true, message: "Machine revoked and disconnected" });
    }
  );

  // Re-enroll machine: regenerates the token + the backend ECDSA pair, disconnects
  // the existing agent, invalidates the old install tokens, and returns an
  // install command flagged --reenroll (purges the residual identity on the
  // machine to avoid the "stale shared.secret" deadlock).
  app.post(
    "/api/machines/:id/re-enroll",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      const machine = await prisma.machine.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      // Regenerates token + backend ECDSA pair, resets agentPublicKey/sharedSecret/boundIp to null
      const result = await regenerateEnrollmentToken(id);

      // Cut the active WS session: the old agent uses a now-invalid secret
      disconnectAgent(id);

      // Invalidate the old install tokens so no vector is left open
      await invalidateInstallTokens(id);

      // Full install command with --reenroll (purge on the machine side)
      const bootstrap = await buildBootstrapArtifacts(
        { id: machine.id, name: machine.name, enrollmentToken: result.enrollmentToken, backendPublicKey: result.backendPublicKey },
        { reenroll: true }
      );

      await logAudit({
        action: "MACHINE_UPDATE",
        resource: "machine",
        resourceId: id,
        userId: user?.sub,
        ipAddress: request.ip,
        details: { action: "re_enrolled" },
      });

      return reply.send({ ...result, bootstrap });
    }
  );

  // Update the agent (self-upgrade to the backend's latest binary)
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
        currentVersion: result.currentVersion,
      });
    }
  );

  // Agent version status: compares the SHA of the currently running binary
  // (reported by heartbeat) to the one the backend serves.
  // Used for the "update available" badge and the initial state of the upgrade modal.
  app.get(
    "/api/machines/:id/agent-status",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const machine = await prisma.machine.findUnique({
        where: { id },
        select: { id: true, agentVersion: true, agentSha256: true },
      });
      if (!machine) return reply.code(404).send({ error: "Machine not found" });

      const servedVersion = getServerAgentVersion();
      const targetSha = await getServerBinarySHA256();
      // Persisted SHA (source of truth) with fallback to the last one seen in memory.
      const currentSha = machine.agentSha256 ?? getLatestAgentSha(id) ?? null;
      const targetAvailable = targetSha !== null;
      // upToDate (SHA): remains the "identical binary" truth, drives the
      // clickability of the upgrade button (manual upgrade possible in dev even if the
      // version is the same).
      const upToDate =
        targetSha !== null && currentSha !== null
          ? currentSha === targetSha
          : null;

      return reply.send({
        currentVersion: machine.agentVersion,
        currentSha,
        targetSha,
        targetAvailable,
        upToDate,
        // updateAvailable (version): drives the "update available" badge/alert.
        // Ignores the build sha → silent between two dev builds, only lights
        // up on a real version change (tag).
        updateAvailable: computeAgentUpdateAvailable(
          servedVersion,
          targetSha,
          machine.agentVersion,
          currentSha
        ),
        upgrading: isUpgradePending(id),
      });
    }
  );
}
