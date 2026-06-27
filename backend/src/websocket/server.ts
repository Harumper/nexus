import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { handleAgentConnection } from "./handler.js";
import { addDashboardClient } from "./dashboard.js";
import {
  isKeycloakEnabled,
  isLocalAuthEnabled,
  verifyKeycloakToken,
} from "../services/keycloak.js";

/**
 * Extraire le token JWT depuis les sous-protocoles WebSocket.
 * Le frontend envoie : new WebSocket(url, ['nexus-auth', '<token>'])
 * Le header Sec-WebSocket-Protocol contient : "nexus-auth, <token>"
 *
 * Utilisé pour Keycloak (le SDK garde le token côté JS) et en fallback
 * pour les anciens clients pré-cookie.
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
 * Extraire le token JWT depuis le cookie httpOnly nexus_token.
 * Le navigateur envoie automatiquement les cookies same-origin sur
 * l'upgrade WebSocket — pas besoin que le frontend les transmette.
 */
function extractTokenFromCookie(request: IncomingMessage): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)nexus_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Vérifier un token JWT (Keycloak et/ou local selon AUTH_MODE).
 * Réutilise la même logique que auth.ts mais sans dépendre d'un FastifyRequest.
 */
async function verifyDashboardToken(
  token: string,
  app: FastifyInstance
): Promise<boolean> {
  // 1. Essayer Keycloak si activé
  if (isKeycloakEnabled()) {
    const result = await verifyKeycloakToken(token);
    if (result.valid) return true;
  }

  // 2. Essayer le JWT local si activé
  if (isLocalAuthEnabled()) {
    try {
      app.jwt.verify(token);
      return true;
    } catch {
      // JWT local invalide
    }
  }

  return false;
}

/**
 * Rejeter une connexion WebSocket avec un code HTTP.
 */
function rejectUpgrade(socket: Duplex, code: number, reason: string): void {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
  socket.destroy();
}

// Keepalive WS : un reverse-proxy (Traefik, nginx…) coupe une connexion dont
// le sens serveur→client reste inactif (les heartbeats agent→serveur ne
// suffisent pas). On envoie donc un ping périodique vers chaque agent — la lib
// websocket de l'agent répond automatiquement au pong via sa boucle de lecture.
// Effet de bord utile : détection des connexions mortes (pas de pong → terminate).
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

  // Heartbeat ping/pong sur les connexions agents (anti-timeout proxy).
  const pingInterval = setInterval(() => {
    for (const ws of agentWss.clients) {
      const sock = ws as typeof ws & { isAlive?: boolean };
      if (sock.isAlive === false) {
        // Pas de pong depuis le dernier ping → connexion morte.
        ws.terminate();
        continue;
      }
      sock.isAlive = false;
      try {
        ws.ping();
      } catch {
        // socket en cours de fermeture — ignoré
      }
    }
  }, WS_PING_INTERVAL_MS);
  // Ne pas empêcher l'arrêt du process à cause de ce timer.
  if (typeof pingInterval.unref === "function") pingInterval.unref();

  // Intercepter les upgrades HTTP pour le WebSocket
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
        // Marqueur de vivacité pour le keepalive ping/pong ci-dessus.
        const sock = ws as typeof ws & { isAlive?: boolean };
        sock.isAlive = true;
        ws.on("pong", () => {
          sock.isAlive = true;
        });
        handleAgentConnection(ws, ip);
      });
    } else if (pathname === "/ws/dashboard") {
      // Cookie httpOnly d'abord (auth locale post-migration), puis Sec-WebSocket-Protocol
      // (Keycloak SDK ou anciens clients).
      const token =
        extractTokenFromCookie(request) || extractTokenFromProtocol(request);

      if (!token) {
        console.warn("[WS] Dashboard connection rejected: no token provided");
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      verifyDashboardToken(token, app)
        .then((valid) => {
          if (!valid) {
            console.warn("[WS] Dashboard connection rejected: invalid token");
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }

          // Token valide — accepter la connexion avec le sous-protocole nexus-auth
          dashboardWss.handleUpgrade(request, socket, head, (ws) => {
            acquireConnSlot(ip);
            onSocketClosed(ws, ip);
            console.log("[WS] Dashboard client authenticated and connected");
            addDashboardClient(ws);
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
