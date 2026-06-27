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

// CRYPTO-004 — handshake ECDHE X25519 (forward secrecy). L'agent envoie sa clé
// publique éphémère (session.hello, signé par sa clé long-terme, déjà vérifié par
// verifyAgentMessage côté handler). Ici on génère NOTRE éphémère, on dérive la clé
// de session K (mémoire seule), et on renvoie session.hello.ack signé par la clé
// per-machine du backend, portant notre clé publique éphémère.
//
// Les clés long-terme AUTHENTIFIENT le handshake ; les clés éphémères CHIFFRENT.
// La clé privée éphémère backend (eb) vit uniquement dans cette fonction et est
// jetée au retour → forward secrecy. K n'est jamais persisté.
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

  // Importer la clé publique éphémère X25519 de l'agent (32 octets bruts) via JWK.
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

  // Notre paire éphémère X25519 (eb). eb.privateKey ne quitte JAMAIS cette fonction.
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
