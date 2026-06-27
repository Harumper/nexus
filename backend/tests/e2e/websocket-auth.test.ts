import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import WebSocket from "ws";

// CONTROL-PLANE-002 — the dashboard WS now revalidates the local account in the
// DB (isActive) like the HTTP middleware. Provide an active user for the valid
// token (and only that id) so the upgrade is accepted for a live account.
vi.mock("../../src/services/database.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "test-user-id" ? { isActive: true } : null
      ),
    },
  },
}));

import { setupWebSocketServer } from "../../src/websocket/server.js";

const JWT_SECRET = "test-secret-for-e2e";
let app: ReturnType<typeof Fastify>;
let port: number;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(jwt, { secret: JWT_SECRET });

  // Simuler les env pour isLocalAuthEnabled
  process.env.AUTH_MODE = "local";

  app.get("/health", async () => ({ status: "ok" }));
  setupWebSocketServer(app);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await app.close();
});

function connectWS(protocols?: string[]): Promise<{ ws: WebSocket; error?: Error }> {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/ws/dashboard`;
    const ws = new WebSocket(url, protocols);

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ ws, error: new Error("Connection timeout") });
    }, 3000);

    ws.on("open", () => {
      clearTimeout(timeout);
      resolve({ ws });
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ws, error: err });
    });

    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timeout);
      resolve({ ws, error: new Error(`HTTP ${res.statusCode}`) });
    });
  });
}

describe("WebSocket Dashboard Authentication", () => {
  it("should reject connection without token", async () => {
    const { error } = await connectWS();
    expect(error).toBeDefined();
    expect(error!.message).toContain("401");
  });

  it("should reject connection with invalid token", async () => {
    const { error } = await connectWS(["nexus-auth", "invalid-token-xxx"]);
    expect(error).toBeDefined();
    expect(error!.message).toContain("401");
  });

  it("should accept connection with valid JWT token", async () => {
    const token = app.jwt.sign({
      sub: "test-user-id",
      username: "testuser",
      role: "ADMIN",
      provider: "local",
    });

    const { ws, error } = await connectWS(["nexus-auth", token]);
    expect(error).toBeUndefined();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("should reject connection with expired JWT token", async () => {
    // Créer un token avec une date d'expiration dans le passé
    const token = app.jwt.sign(
      {
        sub: "test-user-id",
        username: "testuser",
        role: "ADMIN",
        iat: Math.floor(Date.now() / 1000) - 3600, // Issued 1h ago
        exp: Math.floor(Date.now() / 1000) - 60,    // Expired 1 min ago
      },
    );

    const { error } = await connectWS(["nexus-auth", token]);
    expect(error).toBeDefined();
    expect(error!.message).toContain("401");
  });
});
