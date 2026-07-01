import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { deriveSessionKey } from "../../src/services/crypto.js";
import { openEnrollmentSeal } from "../../src/services/enrollment-seal.js";

// Cross-language Go↔Node interop net (TEST-DEBT-001, permanent partial net).
//
// The fixture is produced by the REAL Go code (agent: deriveSessionKey +
// SealToServer) and committed in agent/internal/security/testdata. Here Node
// verifies AGREEMENT:
//   - X25519: Node derives the same session key K as Go for the same keys.
//   - Seal P-256: Node OPENS (via the real openEnrollmentSeal) a seal produced
//     by Go and recovers the exact plaintext → the formats (PEM eph, AES-GCM,
//     HKDF "nexus-enroll") agree.
// If a format/HKDF drifts on one side, this test breaks. This is NOT the full e2e
// (real agent↔backend harness, still owed — TEST-DEBT-001), but it's the most
// critical interop net, already written.

const vectors = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../agent/internal/security/testdata/interop-vectors.json"),
    "utf8"
  )
);

describe("Interop Go↔Node — canal v2 (TEST-DEBT-001 partial net)", () => {
  it("X25519 session key: Node derives the same K as Go", () => {
    const v = vectors.x25519;
    // Import ea_pub (raw 32B) + eb_priv (raw 32B scalar) via JWK, on the Node side.
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
