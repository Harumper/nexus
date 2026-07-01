import bcrypt from "bcrypt";
import { prisma } from "./database.js";

// Ensure the default admin and the builtin settings exist in the DB.
// Idempotent (upsert) — can be called safely on every startup.
export async function ensureBuiltinSeed(): Promise<void> {
  // Default admin (only if it doesn't exist at all — never overwrite a password)
  const adminExists = await prisma.user.findUnique({ where: { username: "admin" } });
  if (!adminExists) {
    const password = await bcrypt.hash("admin", 12);
    await prisma.user.create({
      data: {
        email: "admin@nexus.local",
        username: "admin",
        password,
        role: "ADMIN",
      },
    });
    console.log("[Seed] Created default admin user (username=admin, password=admin — CHANGE IT!)");
  }

  // Default settings (retention, health thresholds)
  const defaultSettings = [
    { key: "metrics_retention_days", value: 30 },
    { key: "health_threshold_cpu", value: 90 },
    { key: "health_threshold_memory", value: 85 },
    { key: "health_threshold_disk", value: 80 },
    { key: "stale_after_days", value: 7 },
    { key: "archive_after_days", value: 30 },
    { key: "delete_after_days", value: 90 },
  ];
  for (const s of defaultSettings) {
    const existing = await prisma.setting.findUnique({ where: { key: s.key } });
    if (!existing) {
      await prisma.setting.create({ data: s });
    }
  }
}
