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
  // NEXUS-AGENT-007 — gouverne le périmètre du sudoers (--type agent|probe).
  type: "AGENT" | "PROBE";
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
    machineType: machine.type,
    binaryToken: binaryTok.rawToken,
    scriptToken: scriptTok.rawToken,
    backendUrl,
    reenroll: opts.reenroll,
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

      // Présence WS live — distincte du status BDD qui a une grâce de 90s
      // après disconnect (anti-flapping, voir handler.ts:126). Le frontend
      // utilise isConnected pour savoir si une action dispatchée passera.
      const connectedIds = new Set(getConnectedMachineIds());
      // Cible servie : version (préférée) + SHA (repli) — calculées une fois.
      const servedVersion = getServerAgentVersion();
      const targetSha = await getServerBinarySHA256();

      const result = machines.map((m) => {
        const { agentSha256, ...rest } = m;
        return {
          ...rest,
          tags: m.tags.map((t) => t.tag),
          sudoersOutdated: isSudoersOutdated(m.sudoersHash),
          isConnected: connectedIds.has(m.id),
          // MAJ agent dispo = version servie ≠ version en cours (agents seulement) ;
          // ignore le sha de build pour ne pas signaler à chaque commit.
          agentUpdateAvailable:
            m.type === "AGENT" &&
            computeAgentUpdateAvailable(servedVersion, targetSha, m.agentVersion, agentSha256),
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
          type: true,
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
        // Live WS presence — voir route /api/machines pour le pourquoi
        isConnected: getAgentSession(id)?.authenticated === true,
        // MAJ par comparaison de version (ignore le sha de build) — voir liste.
        agentUpdateAvailable:
          machine.type === "AGENT" &&
          computeAgentUpdateAvailable(servedVersion, targetSha, machine.agentVersion, agentSha256),
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
          type: true,
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
        type: machine.type,
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

  // Re-enroll machine : régénère le token + la paire ECDSA backend, déconnecte
  // l'agent existant, invalide les anciens tokens d'install, et renvoie une
  // commande d'install marquée --reenroll (purge l'identité résiduelle côté
  // machine pour éviter le deadlock "shared.secret obsolète").
  app.post(
    "/api/machines/:id/re-enroll",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = getUserFromRequest(request);

      const machine = await prisma.machine.findUnique({ where: { id }, select: { id: true, name: true, type: true } });
      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      // Régénère token + paire ECDSA backend, remet agentPublicKey/sharedSecret/boundIp à null
      const result = await regenerateEnrollmentToken(id);

      // Coupe la session WS active : l'ancien agent utilise un secret désormais invalide
      disconnectAgent(id);

      // Invalide les anciens tokens d'install pour ne pas laisser de vecteur ouvert
      await invalidateInstallTokens(id);

      // Commande d'install complète avec --reenroll (purge côté machine)
      const bootstrap = await buildBootstrapArtifacts(
        { id: machine.id, name: machine.name, type: machine.type, enrollmentToken: result.enrollmentToken, backendPublicKey: result.backendPublicKey },
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
        currentVersion: result.currentVersion,
      });
    }
  );

  // Statut de version de l'agent : compare le SHA du binaire en cours
  // d'exécution (rapporté par heartbeat) à celui que le backend sert.
  // Sert au badge "MAJ dispo" et à l'état initial de la modal d'upgrade.
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
      // SHA persisté (source de vérité) avec repli sur le dernier vu en mémoire.
      const currentSha = machine.agentSha256 ?? getLatestAgentSha(id) ?? null;
      const targetAvailable = targetSha !== null;
      // upToDate (SHA) : reste la vérité "binaire identique", pilote la
      // clicabilité du bouton d'upgrade (manuel possible en dev même si la
      // version est la même).
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
        // updateAvailable (version) : pilote la pastille/alerte "MAJ dispo".
        // Ignore le sha de build → silencieux entre deux builds de dev, ne
        // s'allume que sur un vrai changement de version (tag).
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
