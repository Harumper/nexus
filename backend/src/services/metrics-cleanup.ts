import { prisma } from "./database.js";

// Default retention in days (configurable via settings)
const DEFAULT_METRICS_RETENTION = 30;
const DEFAULT_EVENTS_RETENTION = 90;
const DEFAULT_AUDIT_RETENTION = 365;

async function getRetentionDays(): Promise<number> {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "metrics_retention_days" },
    });
    if (setting?.value !== undefined) {
      const days = Number(setting.value);
      if (!isNaN(days) && days >= 0) return days;
    }
  } catch {
    // Setting not found, use default
  }
  return DEFAULT_METRICS_RETENTION;
}

export async function runMetricsCleanup(): Promise<void> {
  const retentionDays = await getRetentionDays();

  // Metrics
  if (retentionDays === 0) {
    // 0 = no DB storage, Prometheus alone handles history
    const result = await prisma.metric.deleteMany({});
    if (result.count > 0) {
      console.log(`[Cleanup] Deleted all metrics (retention=0): ${result.count} rows`);
    }
  } else {
    const metricsCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await prisma.metric.deleteMany({
      where: { timestamp: { lt: metricsCutoff } },
    });
    if (result.count > 0) {
      console.log(`[Cleanup] Deleted ${result.count} metrics older than ${retentionDays} days`);
    }
  }

  // MachineEvents (90 days)
  const eventsCutoff = new Date(Date.now() - DEFAULT_EVENTS_RETENTION * 24 * 60 * 60 * 1000);
  const eventsResult = await prisma.machineEvent.deleteMany({
    where: { timestamp: { lt: eventsCutoff } },
  });
  if (eventsResult.count > 0) {
    console.log(`[Cleanup] Deleted ${eventsResult.count} events older than ${DEFAULT_EVENTS_RETENTION} days`);
  }

  // Resolved alerts (7 days)
  const alertsCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const alertsResult = await prisma.alertState.deleteMany({
    where: {
      status: "RESOLVED",
      resolvedAt: { lt: alertsCutoff },
    },
  });
  if (alertsResult.count > 0) {
    console.log(`[Cleanup] Deleted ${alertsResult.count} resolved alerts older than 7 days`);
  }

  // AuditLog (365 days)
  const auditCutoff = new Date(Date.now() - DEFAULT_AUDIT_RETENTION * 24 * 60 * 60 * 1000);
  const auditResult = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: auditCutoff } },
  });
  if (auditResult.count > 0) {
    console.log(`[Cleanup] Deleted ${auditResult.count} audit logs older than ${DEFAULT_AUDIT_RETENTION} days`);
  }
}
