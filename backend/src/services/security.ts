import { prisma } from "./database.js";
import {
  verifySignature,
  buildSignaturePayload,
  isTimestampValid,
  decryptAES,
} from "./crypto.js";
import type { WSMessage } from "../types/index.js";
import { LRUCache } from "lru-cache";

// LRU nonce cache aligned with the timestamp window (5 min) to block replays.
// The TTL MUST match isTimestampValid (5 min). If shorter, an attacker can replay
// a message within the [TTL, 5min] window after the nonce is evicted.
// 50,000 entries = capacity for ~100 agents × 5 msg/min × 5 min (worst case).
const recentNonces = new LRUCache<string, true>({
  max: 50_000,
  ttl: 5 * 60 * 1000,
});

export async function verifyAgentMessage(
  msg: WSMessage
): Promise<{ valid: boolean; error?: string }> {
  // NEXUS-CRYPTO-005 — hardened order: we NEVER record the nonce before having
  // proven the message's authenticity. An unauthenticated attacker (who only
  // knows a machine_id) can therefore no longer poison/evict the anti-replay
  // cache with nonces from messages with an invalid signature.

  // 1. Verify the timestamp (5-minute window)
  if (!isTimestampValid(msg.timestamp)) {
    return { valid: false, error: "Message timestamp outside valid window" };
  }

  // 2. Retrieve the agent's public key
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

  // 3. Verify the ECDSA signature — BEFORE any mutation of the anti-replay cache
  const signaturePayload = buildSignaturePayload(msg);
  const signatureValid = verifySignature(
    signaturePayload,
    msg.signature,
    machine.agentPublicKey
  );

  if (!signatureValid) {
    return { valid: false, error: "Invalid ECDSA signature" };
  }

  // 4. Anti-replay AFTER verification, key = machine_id:nonce (inter-agent
  // isolation: one machine's traffic cannot evict another's cache). Only
  // authentic messages now touch the cache.
  const nonceKey = `${msg.machine_id}:${msg.nonce}`;
  if (recentNonces.has(nonceKey)) {
    return { valid: false, error: "Duplicate nonce detected (replay attack)" };
  }
  recentNonces.set(nonceKey, true);

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

  if (!machine?.boundIp) return true; // Not bound yet
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

// Decrypts a business payload with the ephemeral session key K (ECDHE handshake).
export function decryptWithSharedKey(encryptedPayload: string, key: Buffer): string {
  return decryptAES(encryptedPayload, key);
}
