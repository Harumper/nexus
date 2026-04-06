import type { WebSocket } from "ws";

// Clients dashboard connectés
const dashboardClients = new Set<WebSocket>();

export function addDashboardClient(ws: WebSocket): void {
  dashboardClients.add(ws);

  ws.on("close", () => {
    dashboardClients.delete(ws);
  });

  ws.on("error", () => {
    dashboardClients.delete(ws);
  });
}

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
