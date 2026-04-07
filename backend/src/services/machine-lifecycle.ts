import { prisma } from "./database.js";
import { broadcastToDashboard } from "../websocket/dashboard.js";

async function getSetting(key: string, defaultValue: number): Promise<number> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  if (setting && typeof setting.value === "number") return setting.value;
  // Handle JSON values like { "value": 7 } or just plain numbers
  if (setting && setting.value !== null) {
    const val = typeof setting.value === "object" && "value" in (setting.value as any)
      ? (setting.value as any).value
      : setting.value;
    if (typeof val === "number") return val;
  }
  return defaultValue;
}

export async function checkMachineLifecycle(): Promise<void> {
  const staleAfterDays = await getSetting("stale_after_days", 7);
  const archiveAfterDays = await getSetting("archive_after_days", 30);
  const deleteAfterDays = await getSetting("delete_after_days", 90);

  const now = new Date();

  // 1. OFFLINE > staleAfterDays → STALE
  const staleThreshold = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000);
  const toStale = await prisma.machine.findMany({
    where: {
      status: "OFFLINE",
      lastHeartbeat: { lt: staleThreshold },
    },
  });

  if (toStale.length > 0) {
    const staleIds = toStale.map(m => m.id);
    await prisma.machine.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "STALE" },
    });
    await prisma.auditLog.createMany({
      data: toStale.map(m => ({
        action: "MACHINE_UPDATE" as const,
        resource: "machine",
        resourceId: m.id,
        machineId: m.id,
        details: { transition: "OFFLINE → STALE", reason: `Offline for ${staleAfterDays}+ days` },
      })),
    });
    for (const machine of toStale) {
      broadcastToDashboard({ type: "machine.status", machine_id: machine.id, data: { status: "STALE" } });
      console.log(`[Lifecycle] Machine ${machine.name} (${machine.id}) → STALE`);
    }
  }

  // 2. STALE > archiveAfterDays → ARCHIVED
  const archiveThreshold = new Date(now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);
  const toArchive = await prisma.machine.findMany({
    where: {
      status: "STALE",
      lastHeartbeat: { lt: archiveThreshold },
    },
  });

  if (toArchive.length > 0) {
    const archiveIds = toArchive.map(m => m.id);
    await prisma.machine.updateMany({
      where: { id: { in: archiveIds } },
      data: { status: "ARCHIVED", archivedAt: now },
    });
    await prisma.auditLog.createMany({
      data: toArchive.map(m => ({
        action: "MACHINE_UPDATE" as const,
        resource: "machine",
        resourceId: m.id,
        machineId: m.id,
        details: { transition: "STALE → ARCHIVED", reason: `Stale for ${archiveAfterDays}+ days` },
      })),
    });
    for (const machine of toArchive) {
      console.log(`[Lifecycle] Machine ${machine.name} (${machine.id}) → ARCHIVED`);
    }
  }

  // 3. ARCHIVED > deleteAfterDays → DELETE
  const deleteThreshold = new Date(now.getTime() - deleteAfterDays * 24 * 60 * 60 * 1000);
  const toDelete = await prisma.machine.findMany({
    where: {
      status: "ARCHIVED",
      archivedAt: { lt: deleteThreshold },
    },
  });

  if (toDelete.length > 0) {
    await prisma.auditLog.createMany({
      data: toDelete.map(m => ({
        action: "MACHINE_DELETE" as const,
        resource: "machine",
        resourceId: m.id,
        details: { transition: "ARCHIVED → DELETED", reason: `Archived for ${deleteAfterDays}+ days` },
      })),
    });
    const deleteIds = toDelete.map(m => m.id);
    await prisma.machine.deleteMany({ where: { id: { in: deleteIds } } });
    for (const machine of toDelete) {
      console.log(`[Lifecycle] Machine ${machine.name} (${machine.id}) → DELETED`);
    }
  }

  if (toStale.length || toArchive.length || toDelete.length) {
    console.log(`[Lifecycle] Transitions: ${toStale.length} → STALE, ${toArchive.length} → ARCHIVED, ${toDelete.length} → DELETED`);
  }
}
