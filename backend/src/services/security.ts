import { prisma } from "./database.js";
import {
  verifySignature,
  buildSignaturePayload,
  isTimestampValid,
  decryptAES,
} from "./crypto.js";
import type { WSMessage } from "../types/index.js";
import { LRUCache } from "lru-cache";

// Cache LRU de nonces aligné sur la fenêtre timestamp (5 min) pour bloquer les replays.
// Le TTL DOIT correspondre à isTimestampValid (5 min). Si plus court, un attaquant peut
// rejouer un message dans la fenêtre [TTL, 5min] après éviction du nonce.
// 50 000 entrées = capacité pour ~100 agents × 5 msg/min × 5 min (worst case).
const recentNonces = new LRUCache<string, true>({
  max: 50_000,
  ttl: 5 * 60 * 1000,
});

export async function verifyAgentMessage(
  msg: WSMessage
): Promise<{ valid: boolean; error?: string }> {
  // 1. Vérifier le timestamp (fenêtre de 5 minutes)
  if (!isTimestampValid(msg.timestamp)) {
    return { valid: false, error: "Message timestamp outside valid window" };
  }

  // 2. Vérifier le nonce (anti-replay)
  if (recentNonces.has(msg.nonce)) {
    return { valid: false, error: "Duplicate nonce detected (replay attack)" };
  }
  recentNonces.set(msg.nonce, true);

  // 3. Récupérer la clé publique de l'agent
  const machine = await prisma.machine.findUnique({
    where: { id: msg.machine_id },
    select: { agentPublicKey: true, status: true, boundIp: true },
  });

  if (!machine || !machine.agentPublicKey) {
    return { valid: false, error: "Machine not found or not enrolled" };
  }

  if (machine.status === "REVOKED") {
    return { valid: false, error: "Machine has been revoked" };
  }

  // 4. Vérifier la signature ECDSA
  const signaturePayload = buildSignaturePayload(msg);
  const signatureValid = verifySignature(
    signaturePayload,
    msg.signature,
    machine.agentPublicKey
  );

  if (!signatureValid) {
    return { valid: false, error: "Invalid ECDSA signature" };
  }

  return { valid: true };
}

export async function verifyAgentIp(
  machineId: string,
  ip: string
): Promise<boolean> {
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { boundIp: true },
  });

  if (!machine?.boundIp) return true; // Pas encore lié
  return machine.boundIp === ip;
}

export async function revokeMachine(
  machineId: string,
  reason: string,
  userId?: string
): Promise<void> {
  await prisma.machine.update({
    where: { id: machineId },
    data: {
      status: "REVOKED",
      keyRevokedAt: new Date(),
      keyRevokedReason: reason,
      enrollmentToken: null,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: "MACHINE_REVOKE",
      resource: "machine",
      resourceId: machineId,
      machineId,
      userId,
      details: { reason },
    },
  });
}

// Déchiffre (master) le shared secret stocké et renvoie la clé AES prête à
// l'emploi. À appeler UNE fois par session, pas par message.
export function deriveSharedKey(machineSharedSecret: string): Buffer {
  const masterSecret = process.env.ECDSA_MASTER_SECRET!;
  const sharedSecretB64 = decryptAES(machineSharedSecret, masterSecret);
  return Buffer.from(sharedSecretB64, "base64");
}

// Déchiffre un payload avec la clé AES déjà dérivée (chemin chaud).
export function decryptWithSharedKey(encryptedPayload: string, key: Buffer): string {
  return decryptAES(encryptedPayload, key);
}
