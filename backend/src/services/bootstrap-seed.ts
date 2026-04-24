import bcrypt from "bcrypt";
import { prisma } from "./database.js";

// Ensure l'admin par defaut et les settings builtin existent en DB.
// Idempotent (upsert) — peut etre appele a chaque demarrage sans risque.
export async function ensureBuiltinSeed(): Promise<void> {
  // Admin par defaut (seulement s'il n'existe pas du tout — ne jamais ecraser un mot de passe)
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

  // Settings par defaut (rétention, seuils de sante)
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
