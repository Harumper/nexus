import crypto from "crypto";
import { prisma } from "./database.js";

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 heure

type Purpose = "install" | "upgrade";

export interface GeneratedToken {
  rawToken: string;
  expiresAt: Date;
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function generateBootstrapToken(
  machineId: string,
  purpose: Purpose,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<GeneratedToken> {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.bootstrapToken.create({
    data: { machineId, purpose, tokenHash, expiresAt },
  });

  return { rawToken, expiresAt };
}

export async function validateBootstrapToken(
  rawToken: string,
  purpose: Purpose
): Promise<{ machineId: string } | null> {
  if (!rawToken || typeof rawToken !== "string") return null;

  const tokenHash = hashToken(rawToken);

  // Claim atomique : single UPDATE qui rejette les tokens utilises ou expires
  const claimed = await prisma.bootstrapToken.updateMany({
    where: {
      tokenHash,
      purpose,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  });

  if (claimed.count === 0) return null;

  const token = await prisma.bootstrapToken.findUnique({
    where: { tokenHash },
    select: { machineId: true },
  });

  return token ? { machineId: token.machineId } : null;
}

export async function invalidateInstallTokens(machineId: string): Promise<void> {
  await prisma.bootstrapToken.updateMany({
    where: { machineId, purpose: "install", usedAt: null },
    data: { usedAt: new Date() },
  });
}

export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.bootstrapToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
