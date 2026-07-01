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
import { isUserPrivilegeMgmtEnabled, isRemoteScriptAllowed } from "../services/privileged-actions.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Auth config (the frontend asks how to authenticate)
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
      features: {
        // SSH key / sudo management via the UI (disabled by default, ADMIN only).
        // Purely indicative for the front end: the real control is in dispatchAction().
        userPrivilegeMgmt: isUserPrivilegeMgmtEnabled(),
        // Remote script execution (disabled by default, ADMIN only, signed
        // scripts). Indicative; the backend is authoritative (dispatchAction + agent signature).
        remoteScript: isRemoteScriptAllowed(),
      },
    });
  });

  // Local login (only if AUTH_MODE=local or both)
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

      // JWT in an httpOnly cookie: protected from JS (XSS), sent automatically
      // by the browser on every same-origin request. SameSite=Strict blocks
      // cross-site CSRF attacks. Secure enabled in prod (HTTPS only).
      reply.setCookie("nexus_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 4 * 60 * 60, // 4h in seconds (aligned with the JWT expiresIn)
      });

      return reply.send({
        // Token also returned for backward compat (existing clients that read it
        // via sessionStorage). New clients ignore this field and read the
        // httpOnly cookie.
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

  // Logout: clear the httpOnly cookie. No DB side-effect (the JWT stays
  // valid until expiration but the browser forgets it).
  app.post(
    "/api/auth/logout",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      reply.clearCookie("nexus_token", { path: "/" });
      const user = (request as { user?: { sub: string } }).user;
      if (user?.sub) {
        await logAudit({
          action: "LOGOUT",
          resource: "user",
          resourceId: user.sub,
          userId: user.sub,
          ipAddress: request.ip,
        });
      }
      return reply.send({ success: true });
    }
  );

  // Current user (works with both token types)
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

      // If Keycloak auth, no user in the local DB
      if (payload.provider === "keycloak") {
        return reply.send({
          id: payload.sub,
          username: payload.username,
          email: payload.email || "",
          role: payload.role,
          provider: "keycloak",
        });
      }

      // Local auth: look up in the DB
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
