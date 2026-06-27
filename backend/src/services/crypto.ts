import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
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

  // Convertir DER → raw (r||s, 64 bytes) pour compatibilité Go
  const raw = derSigToRaw(derSig);
  return raw.toString("base64");
}

// Convertit une signature DER ASN.1 en raw (r||s, 32+32 bytes)
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

    // Détecter le format : si 64 bytes = raw (r||s) de Go, sinon DER
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

// Convertit une signature raw (r||s, 32+32 bytes) en format DER ASN.1
function rawSigToDer(raw: Buffer): Buffer {
  const r = raw.subarray(0, 32);
  const s = raw.subarray(32, 64);

  function encodeInteger(buf: Buffer): Buffer {
    // Retirer les zéros non significatifs
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let trimmed = buf.subarray(i);
    // Ajouter un 0x00 si le bit de poids fort est set (nombre positif en ASN.1)
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

// Dérive la clé de session AES-256 à partir d'un secret ECDH X25519 éphémère,
// avec domain-separation par machine_id (info="nexus-session:<id>", salt vide).
// Identique à l'agent (agent/internal/security/handshake.go deriveSessionKey) —
// interop vérifiée par vecteurs croisés Go↔Node.
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
    // Format Go GCM: nonce:ciphertext+authTag (authTag est les 16 derniers bytes)
    iv = Buffer.from(parts[0], "base64");
    const ciphertextWithTag = Buffer.from(parts[1], "base64");
    // GCM append le tag à la fin du ciphertext
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
  // La version est liée EN TÊTE du payload signé : pas de downgrade silencieux.
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
