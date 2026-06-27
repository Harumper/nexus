import type { WebSocket } from "ws";
import { MSG_TYPES, UNAUTHENTICATED_TYPES, PROTOCOL_VERSION } from "./protocol.js";
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
import { consumeInternalRequest } from "../services/action-dispatcher.js";
import { verifyAgentMessage, verifyAgentIp } from "../services/security.js";
import {
  processHeartbeat,
  processMetrics,
} from "../services/machine-manager.js";
import { onAgentHeartbeat } from "../services/agent-upgrade-tracker.js";
import { prisma } from "../services/database.js";
import { decryptWithSharedKey } from "../services/security.js";
import { processSessionHello } from "../services/session-handshake.js";
import { recordSecurityScan } from "../services/security-scan.js";
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

      // Gate de version de protocole : un agent v1 (sans champ v, ou v != 2) est
      // rejeté EXPLICITEMENT et de façon diagnosticable, pas traité à l'aveugle.
      // Procédure de remédiation : ré-enrôler l'agent (install-agent.sh --reenroll).
      if (msg.v !== PROTOCOL_VERSION) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: `protocol v${msg.v ?? 1} unsupported (server requires v${PROTOCOL_VERSION}) — re-enroll this agent`,
          })
        );
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
      // NEXUS-CRYPTO-003 — vérifier la signature ECDSA (+ timestamp + nonce) de
      // CHAQUE message, pas seulement du premier. La (ré)authentification par
      // message s'appuie sur la clé long-terme stockée, relue en DB fraîche à
      // chaque message : pas de cache pubkey → un agent révoqué/réenrôlé/roté est
      // rejeté dès le message suivant, même session ouverte (invalidation par
      // construction, cf. CRYPTO-004).
      const verification = await verifyAgentMessage(msg);
      if (!verification.valid) {
        console.warn(
          `[WS] Message verification failed for ${msg.machine_id}: ${verification.error}`
        );
        ws.send(JSON.stringify({ type: "error", error: verification.error || "Not authenticated" }));
        return;
      }

      const existing = getAgentSession(msg.machine_id);
      const isBoundAuthedSession =
        existing?.ws === ws && existing.authenticated && existing.established === true;

      // CRYPTO-004 — handshake ECDHE X25519. session.hello (re)lie la connexion et
      // dérive la clé de session K éphémère. C'est le SEUL message accepté avant
      // l'établissement (avec enrollment.request, traité plus haut).
      if (msg.type === MSG_TYPES.SESSION_HELLO) {
        const ipValid = await verifyAgentIp(msg.machine_id, ip);
        if (!ipValid) {
          console.warn(`[WS] IP mismatch for ${msg.machine_id}: ${ip}`);
          ws.send(JSON.stringify({ type: "error", error: "IP binding violation" }));
          ws.close(1008, "IP binding violation");
          return;
        }
        let helloPayload: any;
        try {
          helloPayload = JSON.parse(msg.payload); // session.hello : payload en clair (pas encore de K)
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "Invalid session.hello payload" }));
          return;
        }
        const hs = await processSessionHello(msg.machine_id, helloPayload.ephemeral_pub);
        if (!hs.success) {
          ws.send(JSON.stringify({ type: "error", error: hs.error }));
          return;
        }
        machineId = msg.machine_id;
        registerSession(msg.machine_id, ws, ip);
        authenticateSession(msg.machine_id);
        const s = getAgentSession(msg.machine_id);
        if (s) {
          s.sessionKey = hs.sessionKey; // K éphémère, mémoire seule
          s.established = true;
        }
        ws.send(JSON.stringify(hs.response));
        console.log(`[WS] Session established (ECDHE) for ${msg.machine_id}`);
        return;
      }

      // Message MÉTIER (tout type ≠ session.hello / enrollment.request) : exige une
      // session ÉTABLIE sur CETTE connexion. Couvre TOUS les types métier — aucun
      // n'est traité avant le handshake.
      if (!isBoundAuthedSession) {
        ws.send(
          JSON.stringify({ type: "error", error: "session not established; send session.hello" })
        );
        return;
      }

      // Déchiffrer le payload avec la clé de SESSION éphémère (K du handshake,
      // mémoire seule). FAIL-CLOSED : un agent établi chiffre TOUJOURS son payload
      // (AES-GCM via K). Échec de déchiffrement → rejet, pas de fallback clair.
      const session = getAgentSession(msg.machine_id);
      const sessionKey = session?.sessionKey;
      if (!sessionKey) {
        ws.send(JSON.stringify({ type: "error", error: "session not established; send session.hello" }));
        return;
      }
      let payload: any;
      try {
        payload = JSON.parse(decryptWithSharedKey(msg.payload, sessionKey));
      } catch {
        console.warn(`[WS] Payload decryption failed for ${msg.machine_id} — rejected (no cleartext fallback)`);
        ws.send(JSON.stringify({ type: "error", error: "Invalid encrypted payload" }));
        return;
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

    case MSG_TYPES.SECURITY_PROGRESS:
      // Relayer la progression de l'audit Lynis (console live de l'onglet Sécurité).
      broadcastToDashboard({
        type: "security.audit.progress",
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

  // Audit de sécurité (dispatch asynchrone) : persiste l'historique, évalue les
  // alertes de posture, et diffuse le résultat complet au dashboard (l'onglet
  // Sécurité l'attend via WS — pas de requête HTTP longue, donc pas de 504).
  if (payload.action_id === "security.audit" && payload.success && payload.data) {
    recordSecurityScan(machineId, payload.data).catch((err) =>
      console.error("[Security] recordSecurityScan failed:", err)
    );
    broadcastToDashboard({
      type: "security.audit.result",
      machine_id: machineId,
      data: payload.data,
    });
  }

  const action = payload.success ? "ACTION_COMPLETE" : "ACTION_FAILED";

  // Incrementer les compteurs Prometheus
  if (!payload.success) {
    actionsFailed.inc();
  }

  // Ne pas auditer la complétion d'un dispatch interne (sondes alert-engine) :
  // symétrique du skip d'ACTION_REQUEST côté dispatcher.
  if (consumeInternalRequest(payload.request_id)) {
    return;
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
