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

// CONTROL-PLANE-004 — per-socket throttle on the UNAUTHENTICATED path. Each
// enrollment.request triggers DB lookups + ECDSA verification; a single socket
// replaying them is a CPU/DB amplification the per-IP connection cap does not
// cover. Cap unauthenticated attempts, then close the socket.
const WS_MAX_UNAUTH_MSG = parseInt(
  process.env.WS_MAX_UNAUTH_MSG_PER_SOCKET || "30",
  10
);

export function handleAgentConnection(ws: WebSocket, ip: string): void {
  let machineId: string | null = null;
  let unauthMsgCount = 0;

  ws.on("message", async (raw: Buffer) => {
    try {
      const msg: WSMessage = JSON.parse(raw.toString());

      if (!msg.type || !msg.machine_id) {
        ws.send(JSON.stringify({ type: "error", error: "Missing type or machine_id" }));
        return;
      }

      // Protocol version gate: a v1 agent (no v field, or v != 2) is rejected
      // EXPLICITLY and diagnosably, not processed blindly. Remediation
      // procedure: re-enroll the agent (install-agent.sh --reenroll).
      if (msg.v !== PROTOCOL_VERSION) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: `protocol v${msg.v ?? 1} unsupported (server requires v${PROTOCOL_VERSION}) — re-enroll this agent`,
          })
        );
        return;
      }

      // Enrollment does not require authentication. The session is only
      // registered AFTER a successful enrollment (where the ECDSA proof is
      // verified), never on mere receipt of the message.
      if (UNAUTHENTICATED_TYPES.has(msg.type)) {
        if (++unauthMsgCount > WS_MAX_UNAUTH_MSG) {
          console.warn(
            `[WS] Unauthenticated-path flood from ${ip} (${unauthMsgCount}) → closing`
          );
          ws.close(1008, "rate limited");
          return;
        }
        const enrolled = await handleUnauthenticatedMessage(msg, ws, ip);
        if (enrolled) machineId = msg.machine_id;
        return;
      }

      // === Authenticated messages ===
      // SECURITY: NEVER (re)register or overwrite a session on the strength of
      // an unverified message. Otherwise an attacker could send a forged message
      // carrying another machine's machine_id and close its legitimate session
      // (targeted DoS), since registerSession() closes the existing session.
      // NEXUS-CRYPTO-003 — verify the ECDSA signature (+ timestamp + nonce) of
      // EVERY message, not just the first. Per-message (re)authentication relies
      // on the stored long-term key, re-read fresh from the DB on each message:
      // no pubkey cache → a revoked/re-enrolled/rotated agent is rejected on the
      // very next message, even on an open session (invalidation by construction,
      // cf. CRYPTO-004).
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

      // CRYPTO-004 — ECDHE X25519 handshake. session.hello (re)binds the
      // connection and derives the ephemeral session key K. It is the ONLY
      // message accepted before establishment (along with enrollment.request,
      // handled above).
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
          helloPayload = JSON.parse(msg.payload); // session.hello: cleartext payload (no K yet)
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
          s.sessionKey = hs.sessionKey; // ephemeral K, memory only
          s.established = true;
        }
        ws.send(JSON.stringify(hs.response));
        console.log(`[WS] Session established (ECDHE) for ${msg.machine_id}`);
        return;
      }

      // BUSINESS message (any type ≠ session.hello / enrollment.request): requires
      // a session ESTABLISHED on THIS connection. Covers ALL business types — none
      // is processed before the handshake.
      if (!isBoundAuthedSession) {
        ws.send(
          JSON.stringify({ type: "error", error: "session not established; send session.hello" })
        );
        return;
      }

      // Decrypt the payload with the ephemeral SESSION key (handshake K, memory
      // only). FAIL-CLOSED: an established agent ALWAYS encrypts its payload
      // (AES-GCM via K). Decryption failure → reject, no cleartext fallback.
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

      // Route the message
      await handleAuthenticatedMessage(msg.type, msg.machine_id, payload);
    } catch (err) {
      console.error("[WS] Error handling message:", err);
      ws.send(JSON.stringify({ type: "error", error: "Internal server error" }));
    }
  });

  ws.on("close", () => {
    if (machineId) {
      removeSession(machineId);
      // Do NOT mark OFFLINE immediately: let checkOfflineMachines (runs every
      // 30s, tolerates 90s without a heartbeat) do the work. Marking instantly
      // caused ONLINE/OFFLINE flapping when the WS closed briefly (proxy timeout,
      // network glitch) before the agent reconnected. The 90s grace period
      // absorbs these blips.
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

// Returns true if enrollment succeeded and the session was registered.
async function handleUnauthenticatedMessage(
  msg: WSMessage,
  ws: WebSocket,
  ip: string
): Promise<boolean> {
  if (msg.type === MSG_TYPES.ENROLLMENT_REQUEST) {
    // ENROLLMENT-001 (seal): the payload is the sealed envelope { eph_pub, sealed }.
    // processEnrollment opens the seal (GCM tag verified) BEFORE using the token
    // or the pubkey — no plaintext is touched before the seal is authenticated.
    let sealedRequest: { eph_pub?: string; sealed?: string };
    try {
      sealedRequest = JSON.parse(msg.payload);
    } catch {
      ws.send(
        JSON.stringify({
          type: MSG_TYPES.ENROLLMENT_REJECTED,
          error: "Invalid enrollment payload",
        })
      );
      return false;
    }

    const result = await processEnrollment(msg.machine_id, sealedRequest, ip);

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
      // Feed the self-upgrade tracker: if an agent update is in progress and the
      // reported SHA matches the target binary, the upgrade is confirmed
      // (broadcast agent.upgrade.result).
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

      // Update the per-machine Prometheus gauges
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
      // Evaluate the alert rules against these metrics
      evaluateMetrics(machineId, payload).catch((err) =>
        console.error("[Alert] Evaluation error:", err)
      );
      break;
    }

    case MSG_TYPES.ACTION_RESPONSE:
      await handleActionResponse(machineId, payload);
      break;

    case MSG_TYPES.UPDATE_PROGRESS:
      // Relay the progress (apt system update) to the dashboard clients
      broadcastToDashboard({
        type: "update.progress",
        machine_id: machineId,
        data: payload,
      });
      break;

    case MSG_TYPES.AGENT_UPGRADE_PROGRESS:
      // Relay the agent self-upgrade progress (download/install/restart phases,
      // before the connection is lost).
      broadcastToDashboard({
        type: "agent.upgrade.progress",
        machine_id: machineId,
        data: payload,
      });
      break;

    case MSG_TYPES.SECURITY_PROGRESS:
      // Relay the Lynis audit progress (live console of the Security tab).
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
  // Resolve the promise if someone is waiting for this response
  if (payload.request_id) {
    resolveResponse(payload.request_id, payload);
  }

  // Security audit (async dispatch): persists the history, evaluates the posture
  // alerts, and broadcasts the full result to the dashboard (the Security tab
  // waits for it over WS — no long HTTP request, hence no 504).
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

  // Increment the Prometheus counters
  if (!payload.success) {
    actionsFailed.inc();
  }

  // Do not audit the completion of an internal dispatch (alert-engine probes):
  // symmetric to the ACTION_REQUEST skip on the dispatcher side.
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
