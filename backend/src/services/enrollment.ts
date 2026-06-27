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

// NEXUS-ENROLLMENT-002 — anti-replay sur l'enrôlement, même discipline que
// verifyAgentMessage (security.ts) : TTL aligné sur la fenêtre isTimestampValid
// (5 min). Un enrollment.request rejoué (nonce déjà vu) est rejeté.
const recentNonces = new LRUCache<string, true>({
  max: 50_000,
  ttl: 5 * 60 * 1000,
});

// Payload canonique du proof d'enrôlement. DOIT être identique, octet pour octet,
// à BuildEnrollmentProofPayload côté agent (agent/internal/security/crypto.go).
function buildEnrollmentProofPayload(
  machineId: string,
  enrollmentToken: string,
  nonce: string,
  timestamp: string
): string {
  return `nexus-enroll-proof:v2:${machineId}:${enrollmentToken}:${nonce}:${timestamp}`;
}

export async function createMachineWithEnrollment(
  name: string,
  type: "AGENT" | "PROBE" = "AGENT"
) {
  // Générer la paire ECDSA pour le backend (pour cette machine)
  const { publicKey, privateKey } = generateEcdsaKeypair();
  const enrollmentToken = generateToken("enroll");

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + ENROLLMENT_EXPIRY_HOURS);

  // Créer la machine
  const machine = await prisma.machine.create({
    data: {
      name,
      type,
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
  // 1. Trouver la machine (par machine_id en clair — non secret)
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
  });

  if (!machine) {
    return { success: false, error: "Machine not found" };
  }

  // 2. Vérifier le statut
  if (machine.status !== "ENROLLMENT_PENDING") {
    return { success: false, error: "Machine is not in enrollment pending state" };
  }

  if (!machine.backendPrivateKey) {
    return { success: false, error: "Machine has no backend key" };
  }
  const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey);

  // 3. NEXUS-ENROLLMENT-001 (seal) : OUVRIR le seal AVANT d'exploiter le moindre
  // contenu. openEnrollmentSeal LÈVE si le tag GCM est invalide → on rejette
  // immédiatement, AUCUN octet du plaintext (token, pubkey, proof) n'est touché
  // tant que l'authenticité du seal n'est pas prouvée. Un attaquant on-path sans
  // la clé privée serveur ne peut ni lire le token ni substituer la pubkey.
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

  // 4. Vérifier le token (désormais issu du seal authentifié)
  if (machine.enrollmentToken !== request.enrollment_token) {
    return { success: false, error: "Invalid enrollment token" };
  }

  // 5. Vérifier l'expiration
  if (machine.enrollmentExpiry && machine.enrollmentExpiry < new Date()) {
    return { success: false, error: "Enrollment token has expired" };
  }

  // 5b. NEXUS-ENROLLMENT-002 — anti-replay (depuis le seal authentifié) : fenêtre
  // temporelle + nonce non vu, AVANT toute vérification de proof coûteuse.
  if (!request.timestamp || !isTimestampValid(request.timestamp)) {
    return { success: false, error: "Enrollment timestamp outside valid window" };
  }
  const nonceKey = `${machineId}:${request.nonce}`;
  if (!request.nonce || recentNonces.has(nonceKey)) {
    return { success: false, error: "Duplicate enrollment nonce (replay)" };
  }

  // 6. Vérifier la preuve ECDSA : l'agent signe le payload composite
  // (machine_id|token|nonce|timestamp), pas le seul machine_id statique → frais
  // et non rejouable, et lié à CET enrôlement.
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
  // Le proof est valide et frais : mémoriser le nonce (après preuve d'authenticité,
  // comme CRYPTO-005 — un attaquant ne peut pas empoisonner le cache avant la vérif).
  recentNonces.set(nonceKey, true);

  // CRYPTO-004 : plus de secret de canal dérivé/persisté à l'enrôlement.
  // L'enrôlement n'établit que l'IDENTITÉ (agentPublicKey ↔ machine) ; la clé de
  // session AES est négociée à chaque connexion par le handshake ECDHE éphémère.

  // 8. Mettre à jour la machine — NEXUS-ENROLLMENT-002 : updateMany CONDITIONNEL
  // sur status=ENROLLMENT_PENDING pour fermer la course TOCTOU (deux requêtes
  // concurrentes lisent ENROLLMENT_PENDING avant qu'un update ne tombe). Seul le
  // premier update voit la ligne PENDING ; le second obtient count=0 → rejet.
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
      enrollmentToken: null, // Consommer le token
      enrollmentExpiry: null,
      enrolledAt: new Date(),
      lastHeartbeat: new Date(),
    },
  });
  if (claimed.count !== 1) {
    return { success: false, error: "Enrollment already completed (concurrent request)" };
  }

  // 9. Log audit
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
        type: machine.type,
      },
    },
  });

  // 10. Construire la réponse signée
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const responsePayload = JSON.stringify({
    machine_type: machine.type,
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

  // Régénérer aussi la paire ECDSA
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
