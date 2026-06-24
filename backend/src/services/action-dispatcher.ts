import crypto from "node:crypto";
import { prisma } from "./database.js";
import { isActionAllowed } from "./machine-manager.js";
import { checkCriticalProtection } from "./machine-protection.js";
import { checkPrivilegedAction, checkRoleForAction } from "./privileged-actions.js";
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

export async function dispatchAction(
  machineId: string,
  action: DispatchActionBody,
  userId?: string,
  userRole?: string
): Promise<{ success: boolean; error?: string; requestId?: string }> {
  // 1. Verifier que l'action est autorisee pour le type de machine (PROBE=readonly, AGENT=all)
  if (!(await isActionAllowed(machineId, action.action_id))) {
    return {
      success: false,
      error: `Action '${action.action_id}' is not allowed for this machine type`,
    };
  }

  // 1a. RBAC par action : READONLY = lecture seule, OPERATOR = mutations sauf
  // ADMIN-only (script.execute), ADMIN = tout. userRole undefined = appel
  // système interne (de confiance). Voir privileged-actions.ts.
  const roleCheck = checkRoleForAction(action.action_id, userRole);
  if (!roleCheck.allowed) {
    return { success: false, error: roleCheck.reason };
  }

  // 1b. Actions à persistance hors-bande (clés SSH / sudo) : désactivées par
  // défaut + réservées ADMIN. Voir privileged-actions.ts.
  const privileged = checkPrivilegedAction(
    action.action_id,
    userRole,
    action.params
  );
  if (!privileged.allowed) {
    return { success: false, error: privileged.reason };
  }

  // 2. Vérifier que l'agent est connecté
  const session = getAgentSession(machineId);
  if (!session || !session.authenticated) {
    return { success: false, error: "Agent is not connected" };
  }

  // 3. Récupérer les clés de la machine + flag critique
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { backendPrivateKey: true, sharedSecret: true, isCritical: true },
  });

  if (!machine?.backendPrivateKey || !machine?.sharedSecret) {
    return { success: false, error: "Machine keys not found" };
  }

  // 3b. Protection machines critiques
  const protection = checkCriticalProtection(machine.isCritical, action.action_id, action.params);
  if (!protection.allowed) {
    return { success: false, error: protection.reason };
  }

  const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey);

  // 4. Chiffrer le payload avec le secret partagé
  const masterSecret = process.env.ECDSA_MASTER_SECRET!;
  const sharedSecretB64 = decryptAES(machine.sharedSecret, masterSecret);
  const sharedSecret = Buffer.from(sharedSecretB64, "base64");

  const requestId = `req_${crypto.randomBytes(16).toString("hex")}`;
  const actionPayload = JSON.stringify({
    request_id: requestId,
    action_id: action.action_id,
    params: action.params || {},
  });

  const encryptedPayload = encryptAES(actionPayload, sharedSecret);

  // 5. Signer le message
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();

  const msgForSig = buildSignaturePayload({
    type: "action.request",
    request_id: requestId,
    machine_id: machineId,
    timestamp,
    nonce,
    payload: encryptedPayload,
  });

  const signature = signPayload(msgForSig, backendPrivateKey);

  // 6. Envoyer via WebSocket
  const wsMessage = JSON.stringify({
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

  // 7. Audit log
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
        params: action.params || {},
      } as any,
    },
  });

  return { success: true, requestId };
}
