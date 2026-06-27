import crypto from "node:crypto";
import { prisma } from "./database.js";
import { isActionAllowed } from "./machine-manager.js";
import { checkCriticalProtection } from "./machine-protection.js";
import { checkPrivilegedAction, checkRoleForAction, checkRemoteScriptAction } from "./privileged-actions.js";
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

// Suivi des request_id dispatchés en INTERNE (sondes de l'alert-engine : pas de
// userId). Sert à NE PAS auditer ces actions automatiques (sinon ~2 lignes
// AuditLog/machine/5min noient l'audit réel — ~200M lignes/an à 1000 machines).
// TTL de garde au cas où une réponse n'arrive jamais (timeout) → pas de fuite.
const internalRequests = new Map<string, number>();
const INTERNAL_TTL_MS = 60_000;

function markInternalRequest(requestId: string): void {
  const now = Date.now();
  for (const [id, at] of internalRequests) {
    if (now - at > INTERNAL_TTL_MS) internalRequests.delete(id);
  }
  internalRequests.set(requestId, now);
}

// consumeInternalRequest renvoie true (et oublie l'id) si la requête était
// interne. Appelé par le handler de réponse pour sauter l'audit ACTION_COMPLETE.
export function consumeInternalRequest(requestId: string): boolean {
  return internalRequests.delete(requestId);
}

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

  // 1c. Exécution distante de script : opt-in désactivé par défaut
  // (ALLOW_REMOTE_SCRIPT). Verrou indépendant de la signature (côté agent) et de
  // la capacité sudoers (omise à l'install). Voir privileged-actions.ts.
  const remoteScript = checkRemoteScriptAction(action.action_id);
  if (!remoteScript.allowed) {
    return { success: false, error: remoteScript.reason };
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

  // 7. Audit log — SAUF pour les dispatchs internes (sondes alert-engine, sans
  // userId) : on les marque pour sauter aussi l'ACTION_COMPLETE côté handler.
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
          params: action.params || {},
        } as any,
      },
    });
  } else {
    markInternalRequest(requestId);
  }

  return { success: true, requestId };
}
