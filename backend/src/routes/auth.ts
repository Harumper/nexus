import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { prisma } from "../services/database.js";
import { requireAuth } from "../middleware/auth.js";
import { logAudit } from "../middleware/audit.js";
import {
  isKeycloakEnabled,
  isLocalAuthEnabled,
  getOidcEndpoints,
} from "../services/keycloak.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Auth config (le frontend demande comment s'authentifier)
  app.get("/api/auth/config", async (_request, reply) => {
    const authMode = process.env.AUTH_MODE || "local";
    const keycloakEndpoints = isKeycloakEnabled()
      ? getOidcEndpoints()
      : null;

    return reply.send({
      mode: authMode,
      local: isLocalAuthEnabled(),
      keycloak: isKeycloakEnabled()
        ? {
            url: keycloakEndpoints?.url,
            realm: keycloakEndpoints?.realm,
            clientId: keycloakEndpoints?.clientId,
          }
        : null,
    });
  });

  // Login local (seulement si AUTH_MODE=local ou both)
  app.post(
    "/api/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 1 },
            password: { type: "string", minLength: 1 },
          },
        },
      },
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!isLocalAuthEnabled()) {
        return reply.code(403).send({
          error: "Local authentication is disabled. Use Keycloak SSO.",
        });
      }

      const { username, password } = request.body as {
        username: string;
        password: string;
      };

      const user = await prisma.user.findUnique({ where: { username } });

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const passwordValid = await bcrypt.compare(password, user.password);
      if (!passwordValid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });

      const token = app.jwt.sign(
        {
          sub: user.id,
          username: user.username,
          role: user.role,
          provider: "local",
        },
        { expiresIn: "4h" }
      );

      await logAudit({
        action: "LOGIN",
        resource: "user",
        resourceId: user.id,
        userId: user.id,
        ipAddress: request.ip,
        details: { provider: "local" },
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
        },
      });
    }
  );

  // Current user (fonctionne avec les deux types de tokens)
  app.get(
    "/api/auth/me",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const payload = request.user as {
        sub: string;
        username: string;
        role: string;
        provider?: string;
        email?: string;
      };

      // Si auth Keycloak, pas de user en BDD locale
      if (payload.provider === "keycloak") {
        return reply.send({
          id: payload.sub,
          username: payload.username,
          email: payload.email || "",
          role: payload.role,
          provider: "keycloak",
        });
      }

      // Auth locale : chercher en BDD
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          lastLogin: true,
          createdAt: true,
        },
      });

      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }

      return reply.send({ ...user, provider: "local" });
    }
  );
}
