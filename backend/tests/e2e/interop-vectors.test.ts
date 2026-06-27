import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { deriveSessionKey } from "../../src/services/crypto.js";
import { openEnrollmentSeal } from "../../src/services/enrollment-seal.js";

// Filet d'interop cross-langage Go↔Node (TEST-DEBT-001, filet partiel permanent).
//
// Le fixture est produit par le VRAI code Go (agent : deriveSessionKey +
// SealToServer) et committé dans agent/internal/security/testdata. Ici Node
// vérifie l'ACCORD :
//   - X25519 : Node dérive la même clé de session K que Go pour les mêmes clés.
//   - Seal P-256 : Node OUVRE (via la vraie openEnrollmentSeal) un seal produit
//     par Go et retrouve le plaintext exact → les formats (PEM eph, AES-GCM,
//     HKDF "nexus-enroll") s'accordent.
// Si un format/HKDF dérive d'un côté, ce test casse. Ce n'est PAS le e2e complet
// (harnais agent↔backend réel, toujours dû — TEST-DEBT-001), mais c'est le filet
// d'interop le plus critique, déjà écrit.

const vectors = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../agent/internal/security/testdata/interop-vectors.json"),
    "utf8"
  )
);

describe("Interop Go↔Node — canal v2 (TEST-DEBT-001 partial net)", () => {
  it("X25519 session key: Node derives the same K as Go", () => {
    const v = vectors.x25519;
    // Importer ea_pub (raw 32o) + eb_priv (raw 32o scalar) via JWK, côté Node.
    const eaPubRaw = Buffer.from(v.ea_pub, "base64");
    const eaPub = crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: eaPubRaw.toString("base64url") },
      format: "jwk",
    });
    const ebPrivRaw = Buffer.from(v.eb_priv, "base64");
    const ebPubRaw = Buffer.from(v.eb_pub, "base64");
    const ebPriv = crypto.createPrivateKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        d: ebPrivRaw.toString("base64url"),
        x: ebPubRaw.toString("base64url"),
      },
      format: "jwk",
    });
    const secret = crypto.diffieHellman({ privateKey: ebPriv, publicKey: eaPub });
    const k = deriveSessionKey(secret, v.machine_id);
    expect(k.toString("hex")).toBe(v.k_hex);
  });

  it("P-256 seal: Node opens a Go-produced seal and recovers the plaintext", () => {
    const v = vectors.seal;
    const opened = openEnrollmentSeal(
      v.server_priv_pem,
      v.eph_pub_pem,
      v.sealed,
      v.machine_id
    );
    const expected = Buffer.from(v.plaintext_b64, "base64").toString("utf8");
    expect(opened).toBe(expected);
  });

  it("P-256 seal: a wrong server key cannot open the Go-produced seal", () => {
    const v = vectors.seal;
    const { privateKey: wrongPriv } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(() =>
      openEnrollmentSeal(wrongPriv, v.eph_pub_pem, v.sealed, v.machine_id)
    ).toThrow();
  });
});
