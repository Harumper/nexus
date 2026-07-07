import { prisma } from "./database.js";

// Retention for the remaining time-series-ish tables. Metrics are no longer stored
// in the DB (live-only in-memory buffer; history is Prometheus/Grafana), so there is
// nothing to prune for them here.
const DEFAULT_EVENTS_RETENTION = 90;
const DEFAULT_AUDIT_RETENTION = 365;

export async function runMetricsCleanup(): Promise<void> {
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
