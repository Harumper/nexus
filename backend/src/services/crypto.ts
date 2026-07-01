import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
// NEXUS-CRYPTO-006 — canonical 12-byte (96-bit) GCM nonce, the standard/optimal
// size for AES-GCM (J0 derived directly, without GHASH). decryptAES reads the IV
// FROM the blob, so old 16-byte data still decrypts: only the format of NEW
// encryptions changes.
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const CURVE = "prime256v1"; // P-256

// ===================== ECDSA Key Generation =====================

export function generateEcdsaKeypair(): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: CURVE,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

// ===================== ECDSA Signing & Verification =====================

export function signPayload(payload: string, privateKeyPem: string): string {
  const sign = crypto.createSign("SHA256");
  sign.update(payload);
  sign.end();
  const derSig = sign.sign(privateKeyPem);

  // Convert DER → raw (r||s, 64 bytes) for Go compatibility
  const raw = derSigToRaw(derSig);
  return raw.toString("base64");
}

// Converts a DER ASN.1 signature to raw (r||s, 32+32 bytes)
function derSigToRaw(der: Buffer): Buffer {
  // DER: 0x30 len 0x02 rLen r 0x02 sLen s
  let offset = 2; // skip 0x30 + length
  if (der[0] !== 0x30) throw new Error("Invalid DER signature");

  // r
  if (der[offset] !== 0x02) throw new Error("Invalid DER r");
  offset++;
  const rLen = der[offset++];
  let r = der.subarray(offset, offset + rLen);
  offset += rLen;

  // s
  if (der[offset] !== 0x02) throw new Error("Invalid DER s");
  offset++;
  const sLen = der[offset++];
  let s = der.subarray(offset, offset + sLen);

  // Pad/trim to 32 bytes
  const raw = Buffer.alloc(64);
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  r.copy(raw, 32 - r.length);
  s.copy(raw, 64 - s.length);

  return raw;
}

export function verifySignature(
  payload: string,
  signature: string,
  publicKeyPem: string
): boolean {
  try {
    const sigBuf = Buffer.from(signature, "base64");

    // Detect the format: if 64 bytes = raw (r||s) from Go, otherwise DER
    let derSig: Buffer;
    if (sigBuf.length === 64) {
      derSig = rawSigToDer(sigBuf);
    } else {
      derSig = sigBuf;
    }

    const verify = crypto.createVerify("SHA256");
    verify.update(payload);
    verify.end();
    return verify.verify(publicKeyPem, derSig);
  } catch {
    return false;
  }
}

// Converts a raw signature (r||s, 32+32 bytes) to DER ASN.1 format
function rawSigToDer(raw: Buffer): Buffer {
  const r = raw.subarray(0, 32);
  const s = raw.subarray(32, 64);

  function encodeInteger(buf: Buffer): Buffer {
    // Remove non-significant zeros
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let trimmed = buf.subarray(i);
    // Add a 0x00 if the high-order bit is set (positive number in ASN.1)
    if (trimmed[0] & 0x80) {
      trimmed = Buffer.concat([Buffer.from([0x00]), trimmed]);
    }
    return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed]);
  }

  const rDer = encodeInteger(r);
  const sDer = encodeInteger(s);
  const seq = Buffer.concat([rDer, sDer]);

  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

// ===================== Session Key Derivation (CRYPTO-004) =====================

// Derives the AES-256 session key from an ephemeral ECDH X25519 secret,
// with domain-separation by machine_id (info="nexus-session:<id>", empty salt).
// Identical to the agent (agent/internal/security/handshake.go deriveSessionKey) —
// interop verified via cross Go↔Node vectors.
export function deriveSessionKey(ecdhSecret: Buffer, machineId: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", ecdhSecret, "", `nexus-session:${machineId}`, 32)
  );
}

// ===================== AES-256-GCM Encryption =====================

export function encryptAES(plaintext: string, key: Buffer | string): string {
  const keyBuffer =
    typeof key === "string" ? deriveKeyFromSecret(key) : key;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptAES(encryptedStr: string, key: Buffer | string): string {
  const keyBuffer =
    typeof key === "string" ? deriveKeyFromSecret(key) : key;
  const parts = encryptedStr.split(":");

  let iv: Buffer, authTag: Buffer, encrypted: Buffer;

  if (parts.length === 3) {
    // Format Node.js: iv:authTag:ciphertext
    iv = Buffer.from(parts[0], "base64");
    authTag = Buffer.from(parts[1], "base64");
    encrypted = Buffer.from(parts[2], "base64");
  } else if (parts.length === 2) {
    // Go GCM format: nonce:ciphertext+authTag (authTag is the last 16 bytes)
    iv = Buffer.from(parts[0], "base64");
    const ciphertextWithTag = Buffer.from(parts[1], "base64");
    // GCM appends the tag at the end of the ciphertext
    encrypted = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AUTH_TAG_LENGTH);
    authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - AUTH_TAG_LENGTH);
  } else {
    throw new Error("Invalid encrypted format");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

// ===================== Key Derivation =====================

function deriveKeyFromSecret(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", secret, "", "nexus-master-key", 32)
  );
}

// ===================== Encrypt/Decrypt Private Keys =====================

export function encryptPrivateKey(privateKeyPem: string): string {
  const masterSecret = process.env.ECDSA_MASTER_SECRET;
  if (!masterSecret) {
    throw new Error("ECDSA_MASTER_SECRET is not set");
  }
  return encryptAES(privateKeyPem, masterSecret);
}

export function decryptPrivateKey(encryptedKey: string): string {
  const masterSecret = process.env.ECDSA_MASTER_SECRET;
  if (!masterSecret) {
    throw new Error("ECDSA_MASTER_SECRET is not set");
  }
  return decryptAES(encryptedKey, masterSecret);
}

// ===================== Token Generation =====================

export function generateToken(prefix: string = "enroll"): string {
  const random = crypto.randomBytes(32).toString("hex");
  return `${prefix}_${random}`;
}

export function generateNonce(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ===================== Message Signing =====================

export function buildSignaturePayload(msg: {
  v: number;
  type: string;
  request_id?: string;
  machine_id: string;
  timestamp: string;
  nonce: string;
  payload: string;
}): string {
  // The version is bound AT THE HEAD of the signed payload: no silent downgrade.
  return `${msg.v}:${msg.type}:${msg.request_id || ""}:${msg.machine_id}:${msg.timestamp}:${msg.nonce}:${msg.payload}`;
}

export function isTimestampValid(
  timestamp: string,
  maxSkewMs: number = 5 * 60 * 1000
): boolean {
  const msgTime = new Date(timestamp).getTime();
  const now = Date.now();
  return Math.abs(now - msgTime) <= maxSkewMs;
}
