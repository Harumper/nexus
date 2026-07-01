import crypto from "node:crypto";
import { decryptAES } from "./crypto.js";

// NEXUS-ENROLLMENT-001 (seal) — opening the bootstrap seal (ECIES P-256).
//
// Curve asymmetry (intentional): P-256 HERE (seal + identity), because constrained
// by the PINNED server key (ECDSA P-256) already deployed at install; X25519 for
// the channel (session handshake). Two curves, two roles.
//
// THROWS on authentication failure (invalid GCM tag via decipher.final() in
// decryptAES) → the caller MUST return immediately. NO byte of the sealed
// plaintext (token, pubkey, proof) is used before the tag is verified.
export function openEnrollmentSeal(
  serverPrivatePem: string,
  ephPubPem: string,
  sealed: string,
  machineId: string
): string {
  const serverPriv = crypto.createPrivateKey(serverPrivatePem);
  const ephPub = crypto.createPublicKey(ephPubPem);
  // ECDH P-256 via diffieHellman (NO homegrown point-mult).
  const secret = crypto.diffieHellman({ privateKey: serverPriv, publicKey: ephPub });
  // HKDF domain-separated by machine_id, identical to the agent (interop verified).
  const kSeal = Buffer.from(
    crypto.hkdfSync("sha256", secret, "", `nexus-enroll:${machineId}`, 32)
  );
  // decryptAES verifies the GCM tag (decipher.final throws if invalid) BEFORE
  // returning a single byte of plaintext.
  return decryptAES(sealed, kSeal);
}
