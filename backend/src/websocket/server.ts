import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { handleAgentConnection } from "./handler.js";
import { addDashboardClient } from "./dashboard.js";
import { prisma } from "../services/database.js";
import {
  isKeycloakEnabled,
  isLocalAuthEnabled,
  verifyKeycloakToken,
} from "../services/keycloak.js";

/**
 * Extract the JWT token from the WebSocket subprotocols.
 * The frontend sends: new WebSocket(url, ['nexus-auth', '<token>'])
 * The Sec-WebSocket-Protocol header contains: "nexus-auth, <token>"
 *
 * Used for Keycloak (the SDK keeps the token on the JS side) and as a fallback
 * for old pre-cookie clients.
 */
function extractTokenFromProtocol(request: IncomingMessage): string | null {
  const protocols = request.headers["sec-websocket-protocol"];
  if (!protocols) return null;

  const parts = protocols.split(",").map((p) => p.trim());
  if (parts.length >= 2 && parts[0] === "nexus-auth") {
    return parts[1];
  }
  return null;
}

/**
 * Extract the JWT token from the httpOnly nexus_token cookie.
 * The browser automatically sends same-site cookies on the WebSocket upgrade —
 * no need for the frontend to pass them along.
 */
function extractTokenFromCookie(request: IncomingMessage): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)nexus_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Verify a JWT token (Keycloak and/or local depending on AUTH_MODE).
 * Reuses the same logic as auth.ts but without depending on a FastifyRequest.
 */
async function verifyDashboardToken(
  token: string,
  app: FastifyInstance
): Promise<{ valid: boolean; exp?: number }> {
  // 1. Try Keycloak if enabled
  if (isKeycloakEnabled()) {
    const result = await verifyKeycloakToken(token);
    if (result.valid) return { valid: true, exp: result.payload?.exp };
  }

  // 2. Try the local JWT if enabled
  if (isLocalAuthEnabled()) {
    try {
      const payload = app.jwt.verify(token) as { sub?: string; exp?: number };
      // CONTROL-PLANE-002 — revalidate the account state in the DB like the HTTP
      // middleware authenticate(): a disabled/deleted account must not keep an
      // authenticated dashboard WebSocket until the token expires (up to 4h).
      const dbUser = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { isActive: true },
      });
      if (dbUser && dbUser.isActive) {
        return { valid: true, exp: payload.exp };
      }
    } catch {
      // Invalid local JWT
    }
  }

  return { valid: false };
}

/**
 * Reject a WebSocket connection with an HTTP code.
 */
function rejectUpgrade(socket: Duplex, code: number, reason: string): void {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
  socket.destroy();
}

// WS keepalive: a reverse proxy (Traefik, nginx…) drops a connection whose
// server→client direction stays idle (the agent→server heartbeats are not
// enough). So we send a periodic ping to each agent — the agent's websocket lib
// automatically replies with a pong via its read loop. Useful side effect:
// detection of dead connections (no pong → terminate).
const WS_PING_INTERVAL_MS = parseInt(
  process.env.WS_PING_INTERVAL_MS || "30000",
  10
);

// CONTROL-PLANE-004 — the raw `upgrade` handler runs BEFORE Fastify routing, so
// @fastify/rate-limit never sees WebSocket upgrades. Without a cap, an
// unauthenticated client can flood `new WebSocket(.../ws/agent)` and exhaust
// fds/memory (each socket also joins the keepalive ping loop). We cap live
// connections per source IP and globally, and release the slot on close.
const WS_MAX_CONN_PER_IP = parseInt(process.env.WS_MAX_CONN_PER_IP || "20", 10);
const WS_MAX_CONN_TOTAL = parseInt(process.env.WS_MAX_CONN_TOTAL || "2000", 10);

const connByIp = new Map<string, number>();
let connTotal = 0;

// CONTROL-PLANE-001 — exact-match Origin allowlist for the dashboard upgrade.
// Browsers always send Origin on a WS handshake; a malicious site driving the
// victim's browser would carry the real Origin, so an exact allowlist defeats
// CSWSH as defense-in-depth beyond the SameSite=Strict cookie. Agents (/ws/agent)
// are non-browser clients (no Origin) and are intentionally not subject to this.
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:26032")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Soft cap: returns false when the IP (or the whole server) is at its live-socket
// limit. Checked before handleUpgrade; the slot is only acquired once the socket
// actually opens (no leak if the handshake fails).
function connCapReached(ip: string): boolean {
  return connTotal >= WS_MAX_CONN_TOTAL || (connByIp.get(ip) || 0) >= WS_MAX_CONN_PER_IP;
}

function acquireConnSlot(ip: string): void {
  connByIp.set(ip, (connByIp.get(ip) || 0) + 1);
  connTotal++;
}

function releaseConnSlot(ip: string): void {
  const cur = connByIp.get(ip) || 0;
  if (cur <= 1) connByIp.delete(ip);
  else connByIp.set(ip, cur - 1);
  if (connTotal > 0) connTotal--;
}

// Release exactly once per socket (both "close" and "error" can fire).
function onSocketClosed(ws: { on: (ev: string, cb: () => void) => void }, ip: string): void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseConnSlot(ip);
  };
  ws.on("close", release);
  ws.on("error", release);
}

// CONTROL-PLANE-003 — the `ws` default maxPayload is 100 MiB, and /ws/agent
// JSON.parse()s its first frame BEFORE any signature is verified. Cap the frame
// size so an unauthenticated client can't force the server to buffer/parse a
// ~100 MB message. Legitimate agent/dashboard frames are well under 1 MiB.
const WS_MAX_PAYLOAD_BYTES = parseInt(
  process.env.WS_MAX_PAYLOAD_BYTES || String(1024 * 1024),
  10
);

export function setupWebSocketServer(app: FastifyInstance): void {
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const dashboardWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  // Heartbeat ping/pong on the agent connections (anti proxy-timeout).
  const pingInterval = setInterval(() => {
    for (const ws of agentWss.clients) {
      const sock = ws as typeof ws & { isAlive?: boolean };
      if (sock.isAlive === false) {
        // No pong since the last ping → dead connection.
        ws.terminate();
        continue;
      }
      sock.isAlive = false;
      try {
        ws.ping();
      } catch {
        // socket closing — ignored
      }
    }
  }, WS_PING_INTERVAL_MS);
  // Do not prevent the process from exiting because of this timer.
  if (typeof pingInterval.unref === "function") pingInterval.unref();

  // Intercept HTTP upgrades for the WebSocket
  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    const url = request.url || "";
    const pathname = url.split("?")[0];
    const ip = extractClientIp(request);

    // CONTROL-PLANE-004: cap live connections per IP before doing any upgrade
    // work (handshake, token verification). Reject the flood at the door.
    if (
      (pathname === "/ws/agent" || pathname === "/ws/dashboard") &&
      connCapReached(ip)
    ) {
      console.warn(`[WS] Connection cap reached for ${ip} → 429`);
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }

    if (pathname === "/ws/agent") {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        acquireConnSlot(ip);
        onSocketClosed(ws, ip);
        console.log(`[WS] New agent connection from ${ip}`);
        // Liveness marker for the keepalive ping/pong above.
        const sock = ws as typeof ws & { isAlive?: boolean };
        sock.isAlive = true;
        ws.on("pong", () => {
          sock.isAlive = true;
        });
        handleAgentConnection(ws, ip);
      });
    } else if (pathname === "/ws/dashboard") {
      // httpOnly cookie first (local auth post-migration), then Sec-WebSocket-Protocol
      // (Keycloak SDK or old clients).
      const token =
        extractTokenFromCookie(request) || extractTokenFromProtocol(request);

      if (!token) {
        console.warn("[WS] Dashboard connection rejected: no token provided");
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      // CONTROL-PLANE-001 — CSWSH: exact-match the Origin against the allowlist
      // before accepting the dashboard socket. Exact equality only (no
      // endsWith/includes/wildcard substring matching).
      const origin = request.headers["origin"];
      if (typeof origin !== "string" || !allowedOrigins.some((o) => o === origin)) {
        console.warn(`[WS] Dashboard upgrade rejected: forbidden origin ${origin}`);
        rejectUpgrade(socket, 403, "Forbidden origin");
        return;
      }

      verifyDashboardToken(token, app)
        .then((res) => {
          if (!res.valid) {
            console.warn("[WS] Dashboard connection rejected: invalid token");
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }

          // Valid token — accept the connection with the nexus-auth subprotocol
          dashboardWss.handleUpgrade(request, socket, head, (ws) => {
            acquireConnSlot(ip);
            onSocketClosed(ws, ip);
            console.log("[WS] Dashboard client authenticated and connected");
            addDashboardClient(ws, res.exp);
          });
        })
        .catch((err) => {
          console.error("[WS] Dashboard auth error:", err);
          rejectUpgrade(socket, 500, "Internal Server Error");
        });
    } else {
      socket.destroy();
    }
  });

  console.log("[WS] WebSocket server initialized on /ws/agent and /ws/dashboard");
}

// CONTROL-PLANE-006 — number of trusted reverse-proxy hops that APPEND to
// X-Forwarded-For. The genuine client is this many positions from the right;
// everything to its left is client-supplied and must NOT be trusted.
const TRUSTED_PROXY_HOPS = Math.max(
  0,
  parseInt(process.env.TRUSTED_PROXY_HOPS || "1", 10) || 0,
);

function extractClientIp(request: IncomingMessage): string {
  // Resolve from the RIGHT past the known number of trusted hops. Never take the
  // leftmost (attacker-controlled) value, which would let a client spoof boundIp
  // (verifyAgentIp), defeat per-IP rate-limiting, and poison audit logs.
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const chain = forwarded
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const idx = chain.length - TRUSTED_PROXY_HOPS - 1;
    if (idx >= 0) {
      return chain[idx];
    }
  }
  // No usable XFF: fall back to the socket peer (the proxy itself, or the direct
  // client when no proxy is in front). X-Real-IP is intentionally NOT trusted —
  // it is as forgeable as the leftmost XFF.
  return request.socket.remoteAddress || "unknown";
}
