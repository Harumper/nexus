import type { WebSocket } from "ws";
import type { AgentSession } from "../types/index.js";

// Map: machineId -> AgentSession
const sessions = new Map<string, AgentSession>();

export function registerSession(
  machineId: string,
  ws: WebSocket,
  ip: string
): void {
  // Close the existing session if present
  const existing = sessions.get(machineId);
  if (existing) {
    try {
      existing.ws.close(1000, "Replaced by new connection");
    } catch {
      // ignore
    }
  }

  sessions.set(machineId, {
    machineId,
    ws,
    authenticated: false,
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
    ip,
  });

  console.log(`[WS] Agent session registered: ${machineId} from ${ip}`);
}

export function authenticateSession(machineId: string): void {
  const session = sessions.get(machineId);
  if (session) {
    session.authenticated = true;
    console.log(`[WS] Agent session authenticated: ${machineId}`);
  }
}

export function updateSessionHeartbeat(machineId: string): void {
  const session = sessions.get(machineId);
  if (session) {
    session.lastHeartbeat = new Date();
  }
}

export function removeSession(machineId: string): void {
  sessions.delete(machineId);
  console.log(`[WS] Agent session removed: ${machineId}`);
}

export function getAgentSession(machineId: string): AgentSession | undefined {
  return sessions.get(machineId);
}

export function getConnectedMachineIds(): string[] {
  return Array.from(sessions.entries())
    .filter(([_, s]) => s.authenticated)
    .map(([id]) => id);
}

export function disconnectAgent(machineId: string): boolean {
  const session = sessions.get(machineId);
  if (session) {
    try {
      session.ws.close(1000, "Disconnected by server");
    } catch {
      // ignore
    }
    sessions.delete(machineId);
    return true;
  }
  return false;
}
