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

  for (const machine of toStale) {
    await prisma.machine.update({
      where: { id: machine.id },
      data: { status: "STALE" },
    });
    await prisma.auditLog.create({
      data: {
        action: "MACHINE_UPDATE",
        resource: "machine",
        resourceId: machine.id,
        machineId: machine.id,
        details: { transition: "OFFLINE → STALE", reason: `Offline for ${staleAfterDays}+ days` },
      },
    });
    broadcastToDashboard({
      type: "machine.status",
      machine_id: machine.id,
      data: { status: "STALE" },
    });
    console.log(`[Lifecycle] Machine ${machine.name} (${machine.id}) → STALE`);
  }

  // 2. STALE > archiveAfterDays → ARCHIVED
  const archiveThreshold = new Date(now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);
  const toArchive = await prisma.machine.findMany({
    where: {
      status: "STALE",
      lastHeartbeat: { lt: archiveThreshold },
    },
  });

  for (const machine of toArchive) {
    await prisma.machine.update({
      where: { id: machine.id },
      data: { status: "ARCHIVED", archivedAt: now },
    });
    await prisma.auditLog.create({
      data: {
        action: "MACHINE_UPDATE",
        resource: "machine",
        resourceId: machine.id,
        machineId: machine.id,
        details: { transition: "STALE → ARCHIVED", reason: `Stale for ${archiveAfterDays}+ days` },
      },
    });
    console.log(`[Lifecycle] Machine ${machine.name} (${machine.id}) → ARCHIVED`);
  }

  // 3. ARCHIVED > deleteAfterDays → DELETE
  const deleteThreshold = new Date(now.getTime() - deleteAfterDays * 24 * 60 * 60 * 1000);
  const toDelete = await prisma.machine.findMany({
    where: {
      status: "ARCHIVED",
      archivedAt: { lt: deleteThreshold },
    },
  });

  for (const machine of toDelete) {
    await prisma.auditLog.create({
      data: {
        action: "MACHINE_DELETE",
        resource: "machine",
        resourceId: machine.id,
        details: { transition: "ARCHIVED → DELETED", reason: `Archived for ${deleteAfterDays}+ days` },
      },
    });
    await prisma.machine.delete({ where: { id: machine.id } });
    console.log(`[Lifecycle] Machine ${machine.name} (${machine.id}) → DELETED`);
  }

  if (toStale.length || toArchive.length || toDelete.length) {
    console.log(`[Lifecycle] Transitions: ${toStale.length} → STALE, ${toArchive.length} → ARCHIVED, ${toDelete.length} → DELETED`);
  }
}
