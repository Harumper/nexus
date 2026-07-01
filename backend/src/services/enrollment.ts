import { prisma } from "./database.js";
import {
  generateEcdsaKeypair,
  generateToken,
  encryptPrivateKey,
  decryptPrivateKey,
  verifySignature,
  signPayload,
  buildSignaturePayload,
  generateNonce,
  isTimestampValid,
} from "./crypto.js";
import { PROTOCOL_VERSION } from "../websocket/protocol.js";
import { openEnrollmentSeal } from "./enrollment-seal.js";
import type { EnrollmentRequest, WSMessage } from "../types/index.js";
import { LRUCache } from "lru-cache";

const ENROLLMENT_EXPIRY_HOURS = parseInt(
  process.env.ENROLLMENT_TOKEN_EXPIRY_HOURS || "24",
  10
);

// NEXUS-ENROLLMENT-002 — anti-replay on enrollment, same discipline as
// verifyAgentMessage (security.ts): TTL aligned with the isTimestampValid window
// (5 min). A replayed enrollment.request (already-seen nonce) is rejected.
const recentNonces = new LRUCache<string, true>({
  max: 50_000,
  ttl: 5 * 60 * 1000,
});

// Canonical payload of the enrollment proof. MUST be identical, byte for byte,
// to BuildEnrollmentProofPayload on the agent side (agent/internal/security/crypto.go).
function buildEnrollmentProofPayload(
  machineId: string,
  enrollmentToken: string,
  nonce: string,
  timestamp: string
): string {
  return `nexus-enroll-proof:v2:${machineId}:${enrollmentToken}:${nonce}:${timestamp}`;
}

export async function createMachineWithEnrollment(name: string) {
  // Generate the ECDSA keypair for the backend (for this machine)
  const { publicKey, privateKey } = generateEcdsaKeypair();
  const enrollmentToken = generateToken("enroll");

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + ENROLLMENT_EXPIRY_HOURS);

  // Create the machine
  const machine = await prisma.machine.create({
    data: {
      name,
      status: "ENROLLMENT_PENDING",
      enrollmentToken,
      enrollmentExpiry: expiresAt,
      backendPublicKey: publicKey,
      backendPrivateKey: encryptPrivateKey(privateKey),
    },
  });

  return {
    id: machine.id,
    name: machine.name,
    enrollmentToken,
    backendPublicKey: publicKey,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function processEnrollment(
  machineId: string,
  sealedRequest: { eph_pub?: string; sealed?: string },
  agentIp: string
): Promise<{
  success: boolean;
  error?: string;
  response?: WSMessage;
}> {
  // 1. Find the machine (by cleartext machine_id — not secret)
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
  });

  if (!machine) {
    return { success: false, error: "Machine not found" };
  }

  // 2. Verify the status
  if (machine.status !== "ENROLLMENT_PENDING") {
    return { success: false, error: "Machine is not in enrollment pending state" };
  }

  if (!machine.backendPrivateKey) {
    return { success: false, error: "Machine has no backend key" };
  }
  const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey);

  // 3. NEXUS-ENROLLMENT-001 (seal): OPEN the seal BEFORE using any content.
  // openEnrollmentSeal THROWS if the GCM tag is invalid → we reject
  // immediately, NO byte of the plaintext (token, pubkey, proof) is touched
  // until the seal's authenticity is proven. An on-path attacker without
  // the server private key can neither read the token nor substitute the pubkey.
  if (!sealedRequest.eph_pub || !sealedRequest.sealed) {
    return { success: false, error: "Enrollment request not sealed (re-enroll with a v2 agent)" };
  }
  let request: EnrollmentRequest;
  try {
    const opened = openEnrollmentSeal(
      backendPrivateKey,
      sealedRequest.eph_pub,
      sealedRequest.sealed,
      machineId
    );
    request = JSON.parse(opened) as EnrollmentRequest;
  } catch {
    return { success: false, error: "Enrollment seal verification failed" };
  }

  // 4. Verify the token (now coming from the authenticated seal)
  if (machine.enrollmentToken !== request.enrollment_token) {
    return { success: false, error: "Invalid enrollment token" };
  }

  // 5. Verify expiration
  if (machine.enrollmentExpiry && machine.enrollmentExpiry < new Date()) {
    return { success: false, error: "Enrollment token has expired" };
  }

  // 5b. NEXUS-ENROLLMENT-002 — anti-replay (from the authenticated seal): time
  // window + unseen nonce, BEFORE any costly proof verification.
  if (!request.timestamp || !isTimestampValid(request.timestamp)) {
    return { success: false, error: "Enrollment timestamp outside valid window" };
  }
  const nonceKey = `${machineId}:${request.nonce}`;
  if (!request.nonce || recentNonces.has(nonceKey)) {
    return { success: false, error: "Duplicate enrollment nonce (replay)" };
  }

  // 6. Verify the ECDSA proof: the agent signs the composite payload
  // (machine_id|token|nonce|timestamp), not the static machine_id alone → fresh
  // and non-replayable, and bound to THIS enrollment.
  const proofPayload = buildEnrollmentProofPayload(
    machineId,
    request.enrollment_token,
    request.nonce,
    request.timestamp
  );
  const proofValid = verifySignature(
    proofPayload,
    request.proof,
    request.agent_public_key
  );
  if (!proofValid) {
    return { success: false, error: "Invalid ECDSA proof" };
  }
  // The proof is valid and fresh: memorize the nonce (after proof of authenticity,
  // like CRYPTO-005 — an attacker cannot poison the cache before the verification).
  recentNonces.set(nonceKey, true);

  // CRYPTO-004: no more channel secret derived/persisted at enrollment.
  // Enrollment establishes only IDENTITY (agentPublicKey ↔ machine); the AES
  // session key is negotiated on each connection by the ephemeral ECDHE handshake.

  // 8. Update the machine — NEXUS-ENROLLMENT-002: updateMany CONDITIONAL
  // on status=ENROLLMENT_PENDING to close the TOCTOU race (two concurrent
  // requests read ENROLLMENT_PENDING before an update lands). Only the
  // first update sees the PENDING row; the second gets count=0 → rejection.
  const claimed = await prisma.machine.updateMany({
    where: { id: machineId, status: "ENROLLMENT_PENDING" },
    data: {
      status: "ONLINE",
      agentPublicKey: request.agent_public_key,
      boundIp: agentIp,
      hostname: request.system_info.hostname,
      os: request.system_info.os,
      osVersion: request.system_info.os_version,
      arch: request.system_info.arch,
      ipAddress: Array.isArray(request.system_info.ips) ? request.system_info.ips.join(", ") : agentIp,
      enrollmentToken: null, // Consume the token
      enrollmentExpiry: null,
      enrolledAt: new Date(),
      lastHeartbeat: new Date(),
    },
  });
  if (claimed.count !== 1) {
    return { success: false, error: "Enrollment already completed (concurrent request)" };
  }

  // 9. Audit log
  await prisma.auditLog.create({
    data: {
      action: "MACHINE_ENROLL",
      resource: "machine",
      resourceId: machineId,
      machineId,
      ipAddress: agentIp,
      details: {
        hostname: request.system_info.hostname,
        os: request.system_info.os,
      },
    },
  });

  // 10. Build the signed response
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const responsePayload = JSON.stringify({
    server_public_key: machine.backendPublicKey,
  });

  const msgForSig = buildSignaturePayload({
    v: PROTOCOL_VERSION,
    type: "enrollment.complete",
    machine_id: machineId,
    timestamp,
    nonce,
    payload: responsePayload,
  });

  const signature = signPayload(msgForSig, backendPrivateKey);

  return {
    success: true,
    response: {
      v: PROTOCOL_VERSION,
      type: "enrollment.complete",
      machine_id: machineId,
      timestamp,
      nonce,
      payload: responsePayload,
      signature,
    },
  };
}

export async function regenerateEnrollmentToken(machineId: string) {
  const token = generateToken("enroll");
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + ENROLLMENT_EXPIRY_HOURS);

  // Also regenerate the ECDSA keypair
  const { publicKey, privateKey } = generateEcdsaKeypair();

  await prisma.machine.update({
    where: { id: machineId },
    data: {
      status: "ENROLLMENT_PENDING",
      enrollmentToken: token,
      enrollmentExpiry: expiresAt,
      backendPublicKey: publicKey,
      backendPrivateKey: encryptPrivateKey(privateKey),
      agentPublicKey: null,
      sharedSecret: null,
      boundIp: null,
    },
  });

  return { enrollmentToken: token, backendPublicKey: publicKey, expiresAt };
}
