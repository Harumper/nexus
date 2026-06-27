import crypto from "node:crypto";
import { decryptAES } from "./crypto.js";

// NEXUS-ENROLLMENT-001 (seal) — ouverture du seal de bootstrap (ECIES P-256).
//
// Asymétrie de courbes (volontaire) : P-256 ICI (seal + identité), car contraint
// par la clé serveur PINNÉE (ECDSA P-256) déjà déployée à l'install ; X25519 pour
// le canal (handshake de session). Deux courbes, deux rôles.
//
// LÈVE sur échec d'authentification (tag GCM invalide via decipher.final() dans
// decryptAES) → l'appelant DOIT return immédiatement. AUCUN octet du plaintext
// scellé (token, pubkey, proof) n'est exploité avant la vérification du tag.
export function openEnrollmentSeal(
  serverPrivatePem: string,
  ephPubPem: string,
  sealed: string,
  machineId: string
): string {
  const serverPriv = crypto.createPrivateKey(serverPrivatePem);
  const ephPub = crypto.createPublicKey(ephPubPem);
  // ECDH P-256 via diffieHellman (PAS de point-mult maison).
  const secret = crypto.diffieHellman({ privateKey: serverPriv, publicKey: ephPub });
  // HKDF domain-separée par machine_id, identique à l'agent (interop vérifiée).
  const kSeal = Buffer.from(
    crypto.hkdfSync("sha256", secret, "", `nexus-enroll:${machineId}`, 32)
  );
  // decryptAES vérifie le tag GCM (decipher.final lève si invalide) AVANT de
  // retourner le moindre octet de plaintext.
  return decryptAES(sealed, kSeal);
}
