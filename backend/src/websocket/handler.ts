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
import { onAgentHeartbeat } from "../services/agent-upgrade-tracker.js";
import { prisma } from "../services/database.js";
import { deriveSharedKey, decryptWithSharedKey } from "../services/security.js";
import { updateMachineMetrics, actionsFailed } from "../services/prometheus.js";
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

      // Enrollment ne nécessite pas d'authentification. La session n'est
      // enregistrée qu'APRÈS un enrollment réussi (la preuve ECDSA y est
      // vérifiée), jamais sur la simple réception du message.
      if (UNAUTHENTICATED_TYPES.has(msg.type)) {
        const enrolled = await handleUnauthenticatedMessage(msg, ws, ip);
        if (enrolled) machineId = msg.machine_id;
        return;
      }

      // === Messages authentifiés ===
      // SÉCURITÉ : ne JAMAIS (ré)enregistrer ou écraser une session sur la foi
      // d'un message non vérifié. Sinon un attaquant peut envoyer un message
      // forgé portant le machine_id d'une autre machine et fermer sa session
      // légitime (DoS ciblé), car registerSession() ferme la session existante.
      const existing = getAgentSession(msg.machine_id);
      const isBoundAuthedSession = existing?.ws === ws && existing.authenticated;

      if (!isBoundAuthedSession) {
        // 1) Prouver l'identité par la signature ECDSA AVANT toute mutation de session
        const verification = await verifyAgentMessage(msg);
        if (!verification.valid) {
          console.warn(
            `[WS] Message verification failed for ${msg.machine_id}: ${verification.error}`
          );
          ws.send(JSON.stringify({ type: "error", error: verification.error || "Not authenticated" }));
          return;
        }

        // 2) Vérifier l'IP binding
        const ipValid = await verifyAgentIp(msg.machine_id, ip);
        if (!ipValid) {
          console.warn(`[WS] IP mismatch for ${msg.machine_id}: ${ip}`);
          ws.send(JSON.stringify({ type: "error", error: "IP binding violation" }));
          ws.close(1008, "IP binding violation");
          return;
        }

        // 3) Seulement maintenant : lier cette connexion comme session authentifiée
        //    (remplace une éventuelle ancienne connexion du MÊME agent légitime).
        machineId = msg.machine_id;
        registerSession(msg.machine_id, ws, ip);
        authenticateSession(msg.machine_id);
        console.log(`[WS] Authenticated ${msg.machine_id} via ECDSA signature`);
      }

      // Décrypter le payload. Chemin chaud : la clé AES est mise en cache sur la
      // session (déchiffrée du master une seule fois) → 0 requête DB et 1 seule
      // opération AES par message en régime établi.
      const session = getAgentSession(msg.machine_id);
      let sharedKey = session?.sharedSecretKey;
      if (!sharedKey) {
        const machine = await prisma.machine.findUnique({
          where: { id: msg.machine_id },
          select: { sharedSecret: true },
        });
        if (machine?.sharedSecret) {
          sharedKey = deriveSharedKey(machine.sharedSecret);
          if (session) session.sharedSecretKey = sharedKey;
        }
      }

      let payload: any;
      if (sharedKey) {
        // FAIL-CLOSED : un agent enrôlé chiffre TOUJOURS son payload (AES-GCM via
        // le shared secret, cf. transport/client.go SendSigned). Si le
        // déchiffrement échoue, on rejette — pas de fallback "clair" qui
        // contournerait la confidentialité/intégrité GCM.
        try {
          payload = JSON.parse(decryptWithSharedKey(msg.payload, sharedKey));
        } catch {
          console.warn(`[WS] Payload decryption failed for ${msg.machine_id} — rejected (no cleartext fallback)`);
          ws.send(JSON.stringify({ type: "error", error: "Invalid encrypted payload" }));
          return;
        }
      } else {
        // Pas de shared secret connu (ne devrait pas arriver pour un message
        // authentifié d'un agent enrôlé).
        try {
          payload = JSON.parse(msg.payload);
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "Invalid payload" }));
          return;
        }
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

// Retourne true si l'enrollment a réussi et que la session a été enregistrée.
async function handleUnauthenticatedMessage(
  msg: WSMessage,
  ws: WebSocket,
  ip: string
): Promise<boolean> {
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
      return false;
    }

    // processEnrollment vérifie la preuve ECDSA + le token : l'identité est
    // donc prouvée ici. On peut enregistrer la session en toute sécurité.
    const result = await processEnrollment(msg.machine_id, requestData, ip);

    if (result.success && result.response) {
      registerSession(msg.machine_id, ws, ip);
      authenticateSession(msg.machine_id);
      ws.send(JSON.stringify(result.response));
      return true;
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
  return false;
}

async function handleAuthenticatedMessage(
  type: string,
  machineId: string,
  payload: any
): Promise<void> {
  switch (type) {
    case MSG_TYPES.HEARTBEAT: {
      updateSessionHeartbeat(machineId);
      const hb = payload as HeartbeatData;
      await processHeartbeat(machineId, hb);
      // Alimente le tracker de self-upgrade : si une MAJ d'agent est en cours
      // et que le SHA rapporté correspond au binaire cible, l'upgrade est
      // confirmé (broadcast agent.upgrade.result).
      onAgentHeartbeat(machineId, hb.agent_sha256, hb.agent_version);
      broadcastToDashboard({
        type: "machine.status",
        machine_id: machineId,
        data: { status: "ONLINE", lastHeartbeat: new Date().toISOString() },
      });
      break;
    }

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
      // Relayer la progression (MAJ système apt) vers les clients dashboard
      broadcastToDashboard({
        type: "update.progress",
        machine_id: machineId,
        data: payload,
      });
      break;

    case MSG_TYPES.AGENT_UPGRADE_PROGRESS:
      // Relayer la progression de la self-upgrade de l'agent (phases
      // download/install/restart, avant la perte de connexion).
      broadcastToDashboard({
        type: "agent.upgrade.progress",
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
