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

export function setupWebSocketServer(app: FastifyInstance): void {
  const agentWss = new WebSocketServer({ noServer: true });
  const dashboardWss = new WebSocketServer({ noServer: true });

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

    if (pathname === "/ws/agent") {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        const ip = extractClientIp(request);
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

function extractClientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers["x-real-ip"];
  if (typeof realIp === "string") {
    return realIp;
  }
  return request.socket.remoteAddress || "unknown";
}
