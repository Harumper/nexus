import type { FastifyRequest, FastifyReply } from "fastify";
import type { JwtPayload } from "../types/index.js";
import {
  isKeycloakEnabled,
  isLocalAuthEnabled,
  verifyKeycloakToken,
  mapKeycloakRole,
} from "../services/keycloak.js";
import { prisma } from "../services/database.js";
import crypto from "node:crypto";

// In-memory cache: Keycloak userIds already upserted into the DB (avoids an upsert on every request)
const keycloakUserCache = new Set<string>();

// Upsert a local User for a Keycloak user so that the auditLog.userId FKs work
async function upsertKeycloakUser(
  sub: string,
  username: string,
  email: string | undefined,
  role: "ADMIN" | "OPERATOR" | "READONLY"
): Promise<void> {
  if (keycloakUserCache.has(sub)) return;

  try {
    await prisma.user.upsert({
      where: { id: sub },
      create: {
        id: sub,
        username: `kc:${username}`,
        email: email || `${sub}@keycloak.invalid`,
        // Random, unguessable password: local login is impossible
        password: crypto.randomBytes(32).toString("hex"),
        role,
        isActive: true,
        lastLogin: new Date(),
      },
      update: {
        username: `kc:${username}`,
        email: email || `${sub}@keycloak.invalid`,
        role,
        lastLogin: new Date(),
      },
    });
    keycloakUserCache.add(sub);
  } catch (err) {
    console.error("[Auth] Failed to upsert Keycloak user:", err);
  }
}

// Extract the Bearer token from the request
function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

// Attempt authentication (Keycloak and/or local depending on AUTH_MODE)
async function authenticate(
  request: FastifyRequest
): Promise<JwtPayload | null> {
  const token = extractBearerToken(request);
  if (!token) return null;

  // 1. Try Keycloak if enabled
  if (isKeycloakEnabled()) {
    const result = await verifyKeycloakToken(token);
    if (result.valid && result.payload) {
      const role = mapKeycloakRole(result.payload);
      const jwtPayload: JwtPayload = {
        sub: result.payload.sub,
        username: result.payload.preferred_username,
        role,
        provider: "keycloak",
        email: result.payload.email,
      };
      // Upsert the Keycloak user into the DB (for the auditLog.userId FKs)
      await upsertKeycloakUser(
        result.payload.sub,
        result.payload.preferred_username,
        result.payload.email,
        role
      );
      // Store in request.user for the handlers
      (request as any).user = jwtPayload;
      return jwtPayload;
    }
  }

  // 2. Try the local JWT if enabled
  if (isLocalAuthEnabled()) {
    try {
      const payload = (await request.jwtVerify()) as JwtPayload;
      payload.provider = "local";

      // Revalidate the account state in the DB: a disabled account, or one whose
      // role changed, must NOT keep access until the JWT expires (4h). The DB
      // role is authoritative (not the one frozen into the token).
      const dbUser = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { isActive: true, role: true },
      });
      if (!dbUser || !dbUser.isActive) {
        return null;
      }
      payload.role = dbUser.role as JwtPayload["role"];
      (request as any).user = payload;
      return payload;
    } catch {
      // Invalid local JWT
    }
  }

  return null;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const user = await authenticate(request);
  if (!user) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const user = await authenticate(request);
  if (!user) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "ADMIN") {
    reply.code(403).send({ error: "Admin access required" });
    return;
  }
}

// NEXUS-WEB-AUTHZ-004 — write gate for state-changing routes. READONLY accounts
// must not mutate state (e.g. acknowledge/resolve alerts); only OPERATOR and
// ADMIN may. Use as a preHandler in place of bare requireAuth on writes.
export async function requireOperator(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const user = await authenticate(request);
  if (!user) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") {
    reply.code(403).send({ error: "Operator access required" });
    return;
  }
}

export function getUserFromRequest(request: FastifyRequest): JwtPayload | null {
  try {
    return (request as any).user as JwtPayload;
  } catch {
    return null;
  }
}
