import crypto from "node:crypto";
import { prisma } from "./database.js";
import {
  deriveSessionKey,
  decryptPrivateKey,
  signPayload,
  buildSignaturePayload,
  generateNonce,
} from "./crypto.js";
import { PROTOCOL_VERSION, MSG_TYPES } from "../websocket/protocol.js";
import type { WSMessage } from "../types/index.js";

// CRYPTO-004 — ECDHE X25519 handshake (forward secrecy). The agent sends its
// ephemeral public key (session.hello, signed by its long-term key, already
// verified by verifyAgentMessage on the handler side). Here we generate OUR
// ephemeral, derive the session key K (memory only), and return session.hello.ack
// signed by the backend's per-machine key, carrying our ephemeral public key.
//
// The long-term keys AUTHENTICATE the handshake; the ephemeral keys ENCRYPT.
// The backend's ephemeral private key (eb) lives only in this function and is
// discarded on return → forward secrecy. K is never persisted.
export async function processSessionHello(
  machineId: string,
  agentEphemeralPubB64: string
): Promise<
  | { success: true; sessionKey: Buffer; response: WSMessage }
  | { success: false; error: string }
> {
  if (!agentEphemeralPubB64) {
    return { success: false, error: "Missing agent ephemeral public key" };
  }

  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { backendPrivateKey: true, status: true },
  });
  if (!machine?.backendPrivateKey) {
    return { success: false, error: "Machine has no backend key" };
  }
  if (machine.status === "REVOKED") {
    return { success: false, error: "Machine has been revoked" };
  }

  // Import the agent's ephemeral X25519 public key (32 raw bytes) via JWK.
  let agentEphemeralPub: crypto.KeyObject;
  try {
    const raw = Buffer.from(agentEphemeralPubB64, "base64");
    agentEphemeralPub = crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
      format: "jwk",
    });
  } catch {
    return { success: false, error: "Invalid agent ephemeral public key" };
  }

  // Our ephemeral X25519 pair (eb). eb.privateKey NEVER leaves this function.
  const eb = crypto.generateKeyPairSync("x25519");
  const ecdhSecret = crypto.diffieHellman({
    privateKey: eb.privateKey,
    publicKey: agentEphemeralPub,
  });
  const sessionKey = deriveSessionKey(ecdhSecret, machineId);

  const ebPubRaw = Buffer.from(
    (eb.publicKey.export({ format: "jwk" }) as { x: string }).x,
    "base64url"
  );
  const ebPubB64 = ebPubRaw.toString("base64");

  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ ephemeral_pub: ebPubB64 });

  const msgForSig = buildSignaturePayload({
    v: PROTOCOL_VERSION,
    type: MSG_TYPES.SESSION_HELLO_ACK,
    machine_id: machineId,
    timestamp,
    nonce,
    payload,
  });
  const backendPrivateKey = decryptPrivateKey(machine.backendPrivateKey);
  const signature = signPayload(msgForSig, backendPrivateKey);

  return {
    success: true,
    sessionKey,
    response: {
      v: PROTOCOL_VERSION,
      type: MSG_TYPES.SESSION_HELLO_ACK,
      machine_id: machineId,
      timestamp,
      nonce,
      payload,
      signature,
    },
  };
}
