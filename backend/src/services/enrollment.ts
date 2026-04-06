import { prisma } from "./database.js";
import {
  generateEcdsaKeypair,
  generateToken,
  encryptPrivateKey,
  decryptPrivateKey,
  verifySignature,
  signPayload,
  deriveSharedSecret,
  encryptAES,
  buildSignaturePayload,
  generateNonce,
} from "./crypto.js";
import type { EnrollmentRequest, WSMessage } from "../types/index.js";

const ENROLLMENT_EXPIRY_HOURS = parseInt(
  process.env.ENROLLMENT_TOKEN_EXPIRY_HOURS || "24",
  10
);

export async function createMachineWithEnrollment(
  name: string,
  capabilityNames: string[] = ["monitoring"]
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
      status: "ENROLLMENT_PENDING",
      enrollmentToken,
      enrollmentExpiry: expiresAt,
      backendPublicKey: publicKey,
      backendPrivateKey: encryptPrivateKey(privateKey),
    },
  });

  // Assigner les capabilities
  const capabilities = await prisma.capability.findMany({
    where: { name: { in: capabilityNames } },
  });

  for (const cap of capabilities) {
    await prisma.machineCapability.create({
      data: {
        machineId: machine.id,
        capabilityId: cap.id,
      },
    });
  }

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
  request: EnrollmentRequest,
  agentIp: string
): Promise<{
  success: boolean;
  error?: string;
  response?: WSMessage;
}> {
  // 1. Trouver la machine
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    include: {
      capabilities: { include: { capability: true } },
    },
  });

  if (!machine) {
    return { success: false, error: "Machine not found" };
  }

  // 2. Vérifier le statut
  if (machine.status !== "ENROLLMENT_PENDING") {
    return { success: false, error: "Machine is not in enrollment pending state" };
  }

  // 3. Vérifier le token
  if (machine.enrollmentToken !== request.enrollment_token) {
    return { success: false, error: "Invalid enrollment token" };
  }

  // 4. Vérifier l'expiration
  if (machine.enrollmentExpiry && machine.enrollmentExpiry < new Date()) {
    return { success: false, error: "Enrollment token has expired" };
  }

  // 5. Vérifier la preuve ECDSA (l'agent signe son machine_id avec sa clé privée)
  const proofValid = verifySignature(
    machineId,
    request.proof,
    request.agent_public_key
  );
  if (!proofValid) {
    return { success: false, error: "Invalid ECDSA proof" };
  }

  // 6. Dériver le secret partagé via ECDH
  const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey!);
  const sharedSecret = deriveSharedSecret(
    backendPrivateKey,
    request.agent_public_key
  );

  // 7. Préparer les capabilities
  const capabilityNames = machine.capabilities.map(
    (mc) => mc.capability.name
  );

  // 8. Mettre à jour la machine
  await prisma.machine.update({
    where: { id: machineId },
    data: {
      status: "ONLINE",
      agentPublicKey: request.agent_public_key,
      sharedSecret: encryptAES(sharedSecret.toString("base64"), process.env.ECDSA_MASTER_SECRET!),
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
        capabilities: capabilityNames,
      },
    },
  });

  // 10. Construire la réponse signée
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const responsePayload = JSON.stringify({
    capabilities: capabilityNames,
    server_public_key: machine.backendPublicKey,
  });

  const msgForSig = buildSignaturePayload({
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
