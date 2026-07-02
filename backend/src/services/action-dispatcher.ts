import crypto from "node:crypto";
import { prisma } from "./database.js";
import { checkCriticalProtection } from "./machine-protection.js";
import { checkPrivilegedAction, checkRoleForAction, checkRemoteScriptAction, redactAuditParams } from "./privileged-actions.js";
import { PROTOCOL_VERSION } from "../websocket/protocol.js";
import {
  signPayload,
  buildSignaturePayload,
  generateNonce,
  decryptPrivateKey,
  decryptAES,
  encryptAES,
} from "./crypto.js";
import { getAgentSession } from "../websocket/sessions.js";
import type { DispatchActionBody } from "../types/index.js";
import { actionsDispatched } from "./prometheus.js";

// Tracks request_id of INTERNAL dispatches (alert-engine probes: no userId).
// Used to NOT audit these automatic actions (otherwise ~2 lines of
// AuditLog/machine/5min drown the real audit — ~200M lines/year at 1000 machines).
// Guard TTL in case a response never arrives (timeout) → no leak.
const internalRequests = new Map<string, number>();
const INTERNAL_TTL_MS = 60_000;

function markInternalRequest(requestId: string): void {
  const now = Date.now();
  for (const [id, at] of internalRequests) {
    if (now - at > INTERNAL_TTL_MS) internalRequests.delete(id);
  }
  internalRequests.set(requestId, now);
}

// consumeInternalRequest returns true (and forgets the id) if the request was
// internal. Called by the response handler to skip the ACTION_COMPLETE audit.
export function consumeInternalRequest(requestId: string): boolean {
  return internalRequests.delete(requestId);
}

export async function dispatchAction(
  machineId: string,
  action: DispatchActionBody,
  userId?: string,
  userRole?: string
): Promise<{ success: boolean; error?: string; requestId?: string }> {
  // 1a. Per-action RBAC: READONLY = read-only, OPERATOR = mutations except
  // ADMIN-only (script.execute), ADMIN = everything. userRole undefined = internal
  // system call (trusted). See privileged-actions.ts.
  const roleCheck = checkRoleForAction(action.action_id, userRole);
  if (!roleCheck.allowed) {
    return { success: false, error: roleCheck.reason };
  }

  // 1b. Out-of-band persistence actions (SSH keys / sudo): disabled by
  // default + ADMIN-only. See privileged-actions.ts.
  const privileged = checkPrivilegedAction(
    action.action_id,
    userRole,
    action.params
  );
  if (!privileged.allowed) {
    return { success: false, error: privileged.reason };
  }

  // 1c. Remote script execution: opt-in, disabled by default
  // (ALLOW_REMOTE_SCRIPT). Lock independent of the signature (agent-side) and of
  // the sudoers capability (omitted at install). See privileged-actions.ts.
  const remoteScript = checkRemoteScriptAction(action.action_id);
  if (!remoteScript.allowed) {
    return { success: false, error: remoteScript.reason };
  }

  // 2. Verify the agent is connected AND the ECDHE handshake is complete
  // (session key K present). Without an established handshake, no key to encrypt with.
  const session = getAgentSession(machineId);
  if (!session || !session.authenticated || !session.established || !session.sessionKey) {
    return { success: false, error: "Agent is not connected (session not established)" };
  }

  // 3. Fetch the backend private key (signing) + critical flag
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { backendPrivateKey: true, isCritical: true },
  });

  if (!machine?.backendPrivateKey) {
    return { success: false, error: "Machine keys not found" };
  }

  // 3b. Critical machine protection
  const protection = checkCriticalProtection(machine.isCritical, action.action_id, action.params);
  if (!protection.allowed) {
    return { success: false, error: protection.reason };
  }

  const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey);

  // 4. Encrypt the payload with the ephemeral SESSION key (K from the handshake,
  // memory only) — CRYPTO-004 forward secrecy.
  const sessionKey = session.sessionKey;

  const requestId = `req_${crypto.randomBytes(16).toString("hex")}`;
  const actionPayload = JSON.stringify({
    request_id: requestId,
    action_id: action.action_id,
    params: action.params || {},
  });

  const encryptedPayload = encryptAES(actionPayload, sessionKey);

  // 5. Sign the message
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();

  const msgForSig = buildSignaturePayload({
    v: PROTOCOL_VERSION,
    type: "action.request",
    request_id: requestId,
    machine_id: machineId,
    timestamp,
    nonce,
    payload: encryptedPayload,
  });

  const signature = signPayload(msgForSig, backendPrivateKey);

  // 6. Send via WebSocket
  const wsMessage = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "action.request",
    request_id: requestId,
    machine_id: machineId,
    timestamp,
    nonce,
    payload: encryptedPayload,
    signature,
  });

  session.ws.send(wsMessage);
  actionsDispatched.inc();

  // 7. Audit log — EXCEPT for internal dispatches (alert-engine probes, without
  // userId): we mark them to also skip ACTION_COMPLETE on the handler side.
  if (userId) {
    await prisma.auditLog.create({
      data: {
        action: "ACTION_REQUEST",
        resource: "machine",
        resourceId: machineId,
        machineId,
        userId,
        details: {
          request_id: requestId,
          action_id: action.action_id,
          // Scrub infrastructure secrets (e.g. the Loki destination of
          // logs.configure_shipping) so a Nexus-DB compromise can't map the
          // fleet's log destinations. Keeps the event; drops the "to where".
          params: redactAuditParams(action.action_id, action.params),
        } as any,
      },
    });
  } else {
    markInternalRequest(requestId);
  }

  return { success: true, requestId };
}
