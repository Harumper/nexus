import type { WebSocket } from "ws";
import { MSG_TYPES, UNAUTHENTICATED_TYPES } from "./protocol.js";
import {
  registerSession,
  authenticateSession,
  updateSessionHeartbeat,
  removeSession,
  getAgentSession,
} from "./sessions.js";
import { processEnrollment } from "../services/enrollment.js";
import { broadcastToDashboard } from "./dashboard.js";
import { evaluateMetrics } from "../services/alert-engine.js";
import { resolveResponse } from "../services/action-response.js";
import { verifyAgentMessage, verifyAgentIp } from "../services/security.js";
import {
  processHeartbeat,
  processMetrics,
} from "../services/machine-manager.js";
import { prisma } from "../services/database.js";
import { decryptMessagePayload } from "../services/security.js";
import { updateMachineMetrics, actionsDispatched, actionsFailed } from "../services/prometheus.js";
import type {
  WSMessage,
  EnrollmentRequest,
  HeartbeatData,
  MetricsReport,
} from "../types/index.js";

export function handleAgentConnection(ws: WebSocket, ip: string): void {
  let machineId: string | null = null;

  ws.on("message", async (raw: Buffer) => {
    try {
      const msg: WSMessage = JSON.parse(raw.toString());

      if (!msg.type || !msg.machine_id) {
        ws.send(JSON.stringify({ type: "error", error: "Missing type or machine_id" }));
        return;
      }

      // Enregistrer la session si c'est le premier message
      if (!machineId) {
        machineId = msg.machine_id;
        registerSession(machineId, ws, ip);
      }

      // Enrollment ne nécessite pas d'authentification
      if (UNAUTHENTICATED_TYPES.has(msg.type)) {
        await handleUnauthenticatedMessage(msg, ws, ip);
        return;
      }

      // Vérifier authentification — si pas encore auth, tenter via signature ECDSA
      let alreadyVerified = false;
      const session = getAgentSession(msg.machine_id);
      if (!session?.authenticated) {
        const verification = await verifyAgentMessage(msg);
        if (verification.valid) {
          authenticateSession(msg.machine_id);
          alreadyVerified = true;
          console.log(`[WS] Auto-authenticated ${msg.machine_id} via ECDSA signature`);
        } else {
          ws.send(JSON.stringify({ type: "error", error: "Not authenticated" }));
          return;
        }
      }

      // Vérifier l'IP binding
      const ipValid = await verifyAgentIp(msg.machine_id, ip);
      if (!ipValid) {
        console.warn(`[WS] IP mismatch for ${msg.machine_id}: ${ip}`);
        ws.send(JSON.stringify({ type: "error", error: "IP binding violation" }));
        ws.close(1008, "IP binding violation");
        return;
      }

      // Vérifier signature + timestamp + nonce (skip si déjà vérifié par l'auto-auth)
      if (!alreadyVerified) {
        const verification = await verifyAgentMessage(msg);
        if (!verification.valid) {
          console.warn(
            `[WS] Message verification failed for ${msg.machine_id}: ${verification.error}`
          );
          ws.send(
            JSON.stringify({ type: "error", error: verification.error })
          );
          return;
        }
      }

      // Décrypter le payload
      const machine = await prisma.machine.findUnique({
        where: { id: msg.machine_id },
        select: { sharedSecret: true },
      });

      let payload: any;
      if (machine?.sharedSecret) {
        try {
          const decrypted = decryptMessagePayload(
            msg.payload,
            machine.sharedSecret
          );
          payload = JSON.parse(decrypted);
        } catch {
          // Fallback: essayer de parser directement (pour les messages non chiffrés)
          try {
            payload = JSON.parse(msg.payload);
          } catch {
            ws.send(JSON.stringify({ type: "error", error: "Invalid payload" }));
            return;
          }
        }
      } else {
        payload = JSON.parse(msg.payload);
      }

      // Router le message
      await handleAuthenticatedMessage(msg.type, msg.machine_id, payload);
    } catch (err) {
      console.error("[WS] Error handling message:", err);
      ws.send(JSON.stringify({ type: "error", error: "Internal server error" }));
    }
  });

  ws.on("close", () => {
    if (machineId) {
      removeSession(machineId);
      // Ne PAS marquer OFFLINE immediatement : laisse checkOfflineMachines
      // (tourne toutes les 30s, tolere 90s sans heartbeat) faire le travail.
      // Marquer instantanement causait du flapping ONLINE/OFFLINE quand le WS
      // se fermait brievement (timeout proxy, network glitch) avant que
      // l'agent reconnecte. Le grace period 90s absorbe ces blips.
      prisma.machineEvent
        .create({
          data: { machineId, type: "disconnection" },
        })
        .catch((err) => console.error("[WS] disconnection event create failed:", err));
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS] WebSocket error for ${machineId}:`, err.message);
  });
}

async function handleUnauthenticatedMessage(
  msg: WSMessage,
  ws: WebSocket,
  ip: string
): Promise<void> {
  if (msg.type === MSG_TYPES.ENROLLMENT_REQUEST) {
    let requestData: EnrollmentRequest;
    try {
      requestData = JSON.parse(msg.payload);
    } catch {
      ws.send(
        JSON.stringify({
          type: MSG_TYPES.ENROLLMENT_REJECTED,
          error: "Invalid enrollment payload",
        })
      );
      return;
    }

    const result = await processEnrollment(msg.machine_id, requestData, ip);

    if (result.success && result.response) {
      authenticateSession(msg.machine_id);
      ws.send(JSON.stringify(result.response));
    } else {
      ws.send(
        JSON.stringify({
          type: MSG_TYPES.ENROLLMENT_REJECTED,
          machine_id: msg.machine_id,
          error: result.error,
        })
      );
    }
  }
}

async function handleAuthenticatedMessage(
  type: string,
  machineId: string,
  payload: any
): Promise<void> {
  switch (type) {
    case MSG_TYPES.HEARTBEAT:
      updateSessionHeartbeat(machineId);
      await processHeartbeat(machineId, payload as HeartbeatData);
      broadcastToDashboard({
        type: "machine.status",
        machine_id: machineId,
        data: { status: "ONLINE", lastHeartbeat: new Date().toISOString() },
      });
      break;

    case MSG_TYPES.METRICS_REPORT: {
      const metricsPayload = payload as MetricsReport;
      await processMetrics(machineId, metricsPayload);

      // Mettre a jour les gauges Prometheus par machine
      const machine = await prisma.machine.findUnique({
        where: { id: machineId },
        select: { hostname: true },
      });
      updateMachineMetrics(machineId, machine?.hostname || machineId, {
        cpu_percent: metricsPayload.cpu_percent,
        memory_used: Number(metricsPayload.memory_used),
        memory_total: Number(metricsPayload.memory_total),
        memory_percent: metricsPayload.memory_percent,
        disks: metricsPayload.disks,
        load_avg_1: metricsPayload.load_avg_1,
        uptime: metricsPayload.uptime ? Number(metricsPayload.uptime) : undefined,
      });

      broadcastToDashboard({
        type: "machine.metrics",
        machine_id: machineId,
        data: payload,
      });
      // Évaluer les règles d'alerte contre ces métriques
      evaluateMetrics(machineId, payload).catch((err) =>
        console.error("[Alert] Evaluation error:", err)
      );
      break;
    }

    case MSG_TYPES.ACTION_RESPONSE:
      await handleActionResponse(machineId, payload);
      break;

    case MSG_TYPES.UPDATE_PROGRESS:
      // Relayer la progression vers les clients dashboard
      broadcastToDashboard({
        type: "update.progress",
        machine_id: machineId,
        data: payload,
      });
      break;

    default:
      console.warn(`[WS] Unknown message type: ${type}`);
  }
}

async function handleActionResponse(
  machineId: string,
  payload: any
): Promise<void> {
  // Résoudre la promesse si quelqu'un attend cette réponse
  if (payload.request_id) {
    resolveResponse(payload.request_id, payload);
  }

  const action = payload.success ? "ACTION_COMPLETE" : "ACTION_FAILED";

  // Incrementer les compteurs Prometheus
  if (!payload.success) {
    actionsFailed.inc();
  }

  await prisma.auditLog.create({
    data: {
      action,
      resource: "machine",
      resourceId: machineId,
      machineId,
      details: {
        request_id: payload.request_id,
        action_id: payload.action_id,
        success: payload.success,
        error: payload.error,
      },
    },
  });
}
