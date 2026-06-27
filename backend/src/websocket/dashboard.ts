import type { WebSocket } from "ws";

// Clients dashboard connectés
const dashboardClients = new Set<WebSocket>();
// CONTROL-PLANE-002 — token expiry (epoch seconds) per client, for the liveness
// sweep below: a long-lived socket must not outlive its token.
const clientExpiry = new Map<WebSocket, number>();

export function addDashboardClient(ws: WebSocket, exp?: number): void {
  dashboardClients.add(ws);
  if (typeof exp === "number") {
    clientExpiry.set(ws, exp);
  }

  ws.on("close", () => {
    dashboardClients.delete(ws);
    clientExpiry.delete(ws);
  });

  ws.on("error", () => {
    dashboardClients.delete(ws);
    clientExpiry.delete(ws);
  });
}

// CONTROL-PLANE-002 — periodic sweep closing dashboard sockets whose token has
// expired mid-session (the WS auth only runs once, at upgrade). Without this a
// connected client keeps streaming until it disconnects on its own.
const DASHBOARD_SWEEP_INTERVAL_MS = parseInt(
  process.env.DASHBOARD_SWEEP_INTERVAL_MS || "60000",
  10
);
const sweep = setInterval(() => {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [ws, exp] of clientExpiry) {
    if (exp <= nowSec) {
      try {
        ws.close(1000, "token expired");
      } catch {
        // socket déjà en fermeture — ignoré
      }
      dashboardClients.delete(ws);
      clientExpiry.delete(ws);
    }
  }
}, DASHBOARD_SWEEP_INTERVAL_MS);
if (typeof sweep.unref === "function") sweep.unref();

// Broadcast un message à tous les clients dashboard
export function broadcastToDashboard(message: {
  type: string;
  machine_id?: string;
  data?: any;
}): void {
  const json = JSON.stringify(message);
  for (const client of dashboardClients) {
    if (client.readyState === client.OPEN) {
      client.send(json);
    }
  }
}

export function getDashboardClientCount(): number {
  return dashboardClients.size;
}
