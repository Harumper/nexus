import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { validateBootstrapToken } from "../services/bootstrap.js";

// Chemins par defaut quand le backend tourne dans Docker (binaire + script bake au build)
const AGENT_BINARY_PATH =
  process.env.NEXUS_AGENT_BINARY_PATH || "/app/agent/nexus-agent";
const INSTALL_SCRIPT_PATH =
  process.env.NEXUS_INSTALL_SCRIPT_PATH || "/app/scripts/install-agent.sh";

// Fallback dev : chemins relatifs au repo
const DEV_AGENT_BINARY = resolve(process.cwd(), "../agent/nexus-agent");
const DEV_INSTALL_SCRIPT = resolve(process.cwd(), "../scripts/install-agent.sh");

function resolvePath(primary: string, fallback: string): string | null {
  if (existsSync(primary)) return primary;
  if (existsSync(fallback)) return fallback;
  return null;
}

export async function agentDownloadRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/agents/download?token=...
  // Pas d'auth JWT — le token query est l'auth (single-use, 1h expiry)
  app.get(
    "/api/agents/download",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // Token accepté en header Authorization: Bearer (préféré, ne fuite pas
      // dans les logs d'accès) OU en query ?token= (rétro-compat : bootstrap
      // curl et anciens agents en cours d'auto-upgrade).
      const authHeader = (request.headers["authorization"] as string | undefined) || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      const { token: queryToken } = request.query as { token?: string };
      const token = bearer || queryToken;
      if (!token) {
        return reply.code(400).send({ error: "Missing token (Authorization: Bearer or ?token=)" });
      }

      const claim = await validateBootstrapToken(token, "install");
      if (!claim) {
        return reply.code(401).send({ error: "Invalid or expired token" });
      }

      const binaryPath = resolvePath(AGENT_BINARY_PATH, DEV_AGENT_BINARY);
      if (!binaryPath) {
        request.log.error(
          `[AgentDownload] Binary not found at ${AGENT_BINARY_PATH} or ${DEV_AGENT_BINARY}`
        );
        return reply.code(500).send({ error: "Agent binary not available on server" });
      }

      const stat = statSync(binaryPath);
      reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", 'attachment; filename="nexus-agent"')
        .header("Content-Length", stat.size.toString())
        .header("X-Machine-Id", claim.machineId);

      return reply.send(createReadStream(binaryPath));
    }
  );

  // GET /api/agents/install-script?token=...
  app.get(
    "/api/agents/install-script",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { token } = request.query as { token?: string };
      if (!token) {
        return reply.code(400).send({ error: "Missing token query parameter" });
      }

      const claim = await validateBootstrapToken(token, "install");
      if (!claim) {
        return reply.code(401).send({ error: "Invalid or expired token" });
      }

      const scriptPath = resolvePath(INSTALL_SCRIPT_PATH, DEV_INSTALL_SCRIPT);
      if (!scriptPath) {
        request.log.error(
          `[AgentDownload] Install script not found at ${INSTALL_SCRIPT_PATH} or ${DEV_INSTALL_SCRIPT}`
        );
        return reply.code(500).send({ error: "Install script not available on server" });
      }

      const stat = statSync(scriptPath);
      reply
        .header("Content-Type", "text/x-shellscript")
        .header("Content-Disposition", 'attachment; filename="install-agent.sh"')
        .header("Content-Length", stat.size.toString())
        .header("X-Machine-Id", claim.machineId);

      return reply.send(createReadStream(scriptPath));
    }
  );
}
