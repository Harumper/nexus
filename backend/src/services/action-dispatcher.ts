import crypto from "node:crypto";
import { prisma } from "./database.js";
import { getMachineActions } from "./machine-manager.js";
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

export async function dispatchAction(
  machineId: string,
  action: DispatchActionBody,
  userId?: string
): Promise<{ success: boolean; error?: string; requestId?: string }> {
  // 1. Vérifier que l'action est dans les capabilities de la machine
  const allowedActions = await getMachineActions(machineId);
  if (!allowedActions.includes(action.action_id)) {
    return {
      success: false,
      error: `Action '${action.action_id}' is not allowed for this machine`,
    };
  }

  // 2. Vérifier que l'agent est connecté
  const session = getAgentSession(machineId);
  if (!session || !session.authenticated) {
    return { success: false, error: "Agent is not connected" };
  }

  // 3. Récupérer les clés de la machine
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { backendPrivateKey: true, sharedSecret: true },
  });

  if (!machine?.backendPrivateKey || !machine?.sharedSecret) {
    return { success: false, error: "Machine keys not found" };
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
