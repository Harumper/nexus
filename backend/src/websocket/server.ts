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
  mapKeycloakRole,
} from "../services/keycloak.js";

/**
 * Extraire le token JWT depuis les sous-protocoles WebSocket.
 * Le frontend envoie : new WebSocket(url, ['nexus-auth', '<token>'])
 * Le header Sec-WebSocket-Protocol contient : "nexus-auth, <token>"
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

export function setupWebSocketServer(app: FastifyInstance): void {
  const agentWss = new WebSocketServer({ noServer: true });
  const dashboardWss = new WebSocketServer({ noServer: true });

  // Intercepter les upgrades HTTP pour le WebSocket
  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    const url = request.url || "";
    const pathname = url.split("?")[0];

    if (pathname === "/ws/agent") {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        const ip = extractClientIp(request);
        console.log(`[WS] New agent connection from ${ip}`);
        handleAgentConnection(ws, ip);
      });
    } else if (pathname === "/ws/dashboard") {
      // Extraire et vérifier le token avant d'accepter la connexion
      const token = extractTokenFromProtocol(request);

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
