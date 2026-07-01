import { prisma } from "./database.js";
import { broadcastToDashboard } from "../websocket/dashboard.js";
import { dispatchActionSync } from "./action-sync.js";
import { dispatchNotifications } from "./notifications.js";
import type { AlertConditionType, AlertSeverity, AlertRule } from "@prisma/client";

// In-memory cache of enabled rules: evaluateMetrics runs on EVERY metrics
// report (every ~60s/machine) and used to do a findMany each time.
// We keep a short superset (TTL 30s) invalidated explicitly on rule mutation
// (see invalidateAlertRulesCache in routes/alerts.ts). Per-machine filtering
// is done in memory. The TTL is a safety net if an invalidation is missed.
let rulesCache: AlertRule[] | null = null;
let rulesCacheAt = 0;
const RULES_CACHE_TTL_MS = 30_000;

export function invalidateAlertRulesCache(): void {
  rulesCache = null;
}

async function getEnabledRules(): Promise<AlertRule[]> {
  const now = Date.now();
  if (rulesCache && now - rulesCacheAt < RULES_CACHE_TTL_MS) {
    return rulesCache;
  }
  rulesCache = await prisma.alertRule.findMany({ where: { enabled: true } });
  rulesCacheAt = now;
  return rulesCache;
}

// Conditions that require an active poll (dispatch action to the agent)
const HEALTH_CHECK_CONDITIONS: AlertConditionType[] = [
  "SERVICE_FAILED",
  "TIMER_FAILED",
  "CRON_FAILED",
  "UPDATES_AVAILABLE",
];

// Conditions that require an SSL scan (less frequent, heavier)
const CERT_CHECK_CONDITIONS: AlertConditionType[] = ["CERT_EXPIRING"];

// Posture condition: evaluated against the LATEST persisted SecurityScan (no
// agent poll — Lynis is too slow). Also triggered after each audit.
const HARDENING_CHECK_CONDITIONS: AlertConditionType[] = ["HARDENING_INDEX_BELOW"];

// ===================== Active alerts cache =====================
// In-memory Set of (ruleId:machineId) currently FIRING/ACKNOWLEDGED.
// It's a SUPERSET of the DB state (initialized at boot, fed by fireAlert).
// Lets resolveAlert/fireAlert avoid a findFirst per (rule×machine×cycle)
// when nothing is alerting — the vast-majority case on the hot path
// (evaluateMetrics runs on every metric report × N machines).
const firingKeys = new Set<string>();
const fkey = (ruleId: string, machineId: string) => `${ruleId}:${machineId}`;

// To be called at backend startup: reloads the FIRING state from the DB.
export async function initAlertState(): Promise<void> {
  firingKeys.clear();
  const active = await prisma.alertState.findMany({
    where: { status: { in: ["FIRING", "ACKNOWLEDGED"] } },
    select: { ruleId: true, machineId: true },
  });
  for (const a of active) firingKeys.add(fkey(a.ruleId, a.machineId));
  console.log(`[AlertEngine] ${firingKeys.size} active alert(s) loaded into cache`);
}

// ===================== Incoming metrics evaluation =====================

export async function evaluateMetrics(
  machineId: string,
  metrics: {
    cpu_percent?: number;
    memory_percent?: number;
    disks?: Array<{ percent: number; mountpoint: string }>;
    load_avg_1?: number;
  }
): Promise<void> {
  // Enabled rules concerning this machine, filtered in memory from the
  // cache (avoids a findMany per metrics report on the hot path).
  const enabled = await getEnabledRules();
  const rules = enabled.filter(
    (r) => r.machineIds.length === 0 || r.machineIds.includes(machineId)
  );

  for (const rule of rules) {
    const triggered = checkCondition(rule.conditionType, rule.threshold, metrics);

    if (triggered) {
      await fireAlert(rule.id, machineId, rule.severity, {
        conditionType: rule.conditionType,
        threshold: rule.threshold,
        value: getCurrentValue(rule.conditionType, metrics),
      });
    } else {
      await resolveAlert(rule.id, machineId);
    }
  }
}

// ===================== Offline machines check =====================

export async function evaluateOfflineAlerts(): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: {
      enabled: true,
      conditionType: "MACHINE_OFFLINE",
    },
  });

  if (rules.length === 0) return;

  for (const rule of rules) {
    const durationSeconds = rule.durationSeconds || 60;
    const threshold = new Date(Date.now() - durationSeconds * 1000);

    // Machines that should be online but no longer are
    const offlineMachines = await prisma.machine.findMany({
      where: {
        status: "OFFLINE",
        lastHeartbeat: { lt: threshold },
        ...(rule.machineIds.length > 0
          ? { id: { in: rule.machineIds } }
          : {}),
      },
      select: { id: true, name: true },
    });

    for (const machine of offlineMachines) {
      await fireAlert(rule.id, machine.id, rule.severity, {
        conditionType: "MACHINE_OFFLINE",
        machineName: machine.name,
        offlineSince: threshold.toISOString(),
      });
    }

    // Resolve alerts for machines that came back online
    const onlineMachineIds = await prisma.machine.findMany({
      where: {
        status: "ONLINE",
        ...(rule.machineIds.length > 0
          ? { id: { in: rule.machineIds } }
          : {}),
      },
      select: { id: true },
    });

    for (const machine of onlineMachineIds) {
      await resolveAlert(rule.id, machine.id);
    }
  }
}

// ===================== Periodic health checks (services/timers/updates) =====================

/**
 * For each ONLINE machine with at least one enabled SERVICE_FAILED/TIMER_FAILED/
 * UPDATES_AVAILABLE rule, dispatches system.health_summary and evaluates the rules.
 */
export async function evaluateHealthAlerts(): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: {
      enabled: true,
      conditionType: { in: HEALTH_CHECK_CONDITIONS },
    },
  });
  if (rules.length === 0) return;

  // Collect the concerned machineIds (if machineIds empty = all)
  const needAllMachines = rules.some((r) => r.machineIds.length === 0);
  const specificIds = new Set(rules.flatMap((r) => r.machineIds));

  const machines = await prisma.machine.findMany({
    where: {
      status: "ONLINE",
      ...(needAllMachines ? {} : { id: { in: Array.from(specificIds) } }),
    },
    select: { id: true, name: true },
  });

  // Dispatch in parallel with limited concurrency (10 machines at a time)
  const concurrency = 10;
  for (let i = 0; i < machines.length; i += concurrency) {
    const batch = machines.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (machine) => {
        try {
          const summary: any = await dispatchActionSync(
            machine.id,
            "system.health_summary",
            {},
            20_000
          );
          await evaluateHealthForMachine(machine.id, summary, rules);
        } catch (err) {
          // Ignore silently: the machine may have gone offline in the meantime
        }
      })
    );
  }
}

async function evaluateHealthForMachine(
  machineId: string,
  summary: any,
  rules: any[]
): Promise<void> {
  const applicableRules = rules.filter(
    (r) => r.machineIds.length === 0 || r.machineIds.includes(machineId)
  );

  for (const rule of applicableRules) {
    const triggered = checkHealthCondition(rule, summary);
    if (triggered.fired) {
      await fireAlert(rule.id, machineId, rule.severity, triggered.details);
    } else {
      await resolveAlert(rule.id, machineId);
    }
  }
}

function checkHealthCondition(
  rule: any,
  summary: any
): { fired: boolean; details: Record<string, any> } {
  switch (rule.conditionType) {
    case "SERVICE_FAILED": {
      const failed = summary?.services?.failed || [];
      // Optional filter by pattern (service name)
      const matching = rule.targetPattern
        ? failed.filter((f: any) => String(f.unit || "").includes(rule.targetPattern))
        : failed;
      return {
        fired: matching.length > 0,
        details: {
          conditionType: "SERVICE_FAILED",
          failedServices: matching.map((f: any) => f.unit),
          count: matching.length,
        },
      };
    }
    case "TIMER_FAILED": {
      const failed = summary?.timers?.failed || [];
      const matching = rule.targetPattern
        ? failed.filter((f: any) => String(f.timer || "").includes(rule.targetPattern))
        : failed;
      return {
        fired: matching.length > 0,
        details: {
          conditionType: "TIMER_FAILED",
          failedTimers: matching.map((f: any) => f.timer),
          count: matching.length,
        },
      };
    }
    case "UPDATES_AVAILABLE": {
      const count = summary?.updates?.count || 0;
      const security = summary?.updates?.security || 0;
      const threshold = rule.threshold ?? 0;
      // Fire if count > threshold (e.g. threshold=0 -> on any update)
      return {
        fired: count > threshold,
        details: {
          conditionType: "UPDATES_AVAILABLE",
          count,
          security,
          threshold,
        },
      };
    }
    default:
      return { fired: false, details: {} };
  }
}

// ===================== Cert expiration scan (every 6h) =====================

export async function evaluateCertAlerts(): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: {
      enabled: true,
      conditionType: { in: CERT_CHECK_CONDITIONS },
    },
  });
  if (rules.length === 0) return;

  const needAllMachines = rules.some((r) => r.machineIds.length === 0);
  const specificIds = new Set(rules.flatMap((r) => r.machineIds));

  const machines = await prisma.machine.findMany({
    where: {
      status: "ONLINE",
      ...(needAllMachines ? {} : { id: { in: Array.from(specificIds) } }),
    },
    select: { id: true, name: true },
  });

  const concurrency = 5;
  for (let i = 0; i < machines.length; i += concurrency) {
    const batch = machines.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (machine) => {
        try {
          const scan: any = await dispatchActionSync(machine.id, "ssl.scan", {}, 30_000);
          const minDays = scan?.min_days ?? 9999;
          const expiring = scan?.expiring_soon || [];

          const applicableRules = rules.filter(
            (r) => r.machineIds.length === 0 || r.machineIds.includes(machine.id)
          );

          for (const rule of applicableRules) {
            const threshold = rule.threshold ?? 30;
            // Fire if at least one cert expires within <= threshold days
            const triggering = (scan?.certs || []).filter((c: any) => c.days_remaining <= threshold);
            if (triggering.length > 0) {
              await fireAlert(rule.id, machine.id, rule.severity, {
                conditionType: "CERT_EXPIRING",
                threshold,
                minDays,
                count: triggering.length,
                certs: triggering.map((c: any) => ({
                  path: c.path,
                  subject: c.subject,
                  days_remaining: c.days_remaining,
                })),
              });
            } else {
              await resolveAlert(rule.id, machine.id);
            }
            // expiring is used for logging but not for the trigger
            void expiring;
          }
        } catch (err) {
          // Ignore
        }
      })
    );
  }
}

// ===================== Hardening posture =====================

// Evaluates HARDENING_INDEX_BELOW rules against the LATEST persisted
// SecurityScan of each targeted machine. No agent poll (DB read only):
// callable frequently and after each audit. Optional machineId = scope.
export async function evaluateHardeningAlerts(machineId?: string): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true, conditionType: { in: HARDENING_CHECK_CONDITIONS } },
  });
  if (rules.length === 0) return;

  // Targeted machines: if machineId is provided, we limit to it.
  const needAll = rules.some((r) => r.machineIds.length === 0);
  const specificIds = new Set(rules.flatMap((r) => r.machineIds));
  const machines = await prisma.machine.findMany({
    where: {
      ...(machineId ? { id: machineId } : needAll ? {} : { id: { in: Array.from(specificIds) } }),
    },
    select: { id: true },
  });

  for (const machine of machines) {
    const latest = await prisma.securityScan.findFirst({
      where: { machineId: machine.id },
      orderBy: { scannedAt: "desc" },
      select: { hardeningIndex: true },
    });

    const applicable = rules.filter(
      (r) => r.machineIds.length === 0 || r.machineIds.includes(machine.id)
    );

    for (const rule of applicable) {
      const threshold = rule.threshold ?? 60;
      // We only trigger if we have a valid index (>= 0) below the threshold.
      // Index -1 (Lynis with no index) or no scan -> trigger nothing.
      if (latest && latest.hardeningIndex >= 0 && latest.hardeningIndex < threshold) {
        await fireAlert(rule.id, machine.id, rule.severity, {
          conditionType: "HARDENING_INDEX_BELOW",
          threshold,
          hardeningIndex: latest.hardeningIndex,
        });
      } else {
        await resolveAlert(rule.id, machine.id);
      }
    }
  }
}

// ===================== Fire / Resolve =====================

async function fireAlert(
  ruleId: string,
  machineId: string,
  severity: AlertSeverity,
  details: Record<string, any>
): Promise<void> {
  const k = fkey(ruleId, machineId);
  // If the key isn't in the cache (superset), there's certainly no active
  // alert: we skip the findFirst and create directly.
  const existing = firingKeys.has(k)
    ? await prisma.alertState.findFirst({
        where: {
          ruleId,
          machineId,
          status: { in: ["FIRING", "ACKNOWLEDGED"] },
        },
        include: { rule: true },
      })
    : null;

  if (existing) {
    // Check the cooldown
    if (
      existing.lastNotified &&
      Date.now() - existing.lastNotified.getTime() < (existing.rule.cooldownSeconds * 1000)
    ) {
      return; // Still in cooldown
    }

    // Update the last notification
    await prisma.alertState.update({
      where: { id: existing.id },
      data: { lastNotified: new Date(), details: details as any },
    });
    return;
  }

  // Create a new alert
  const alertState = await prisma.alertState.create({
    data: {
      ruleId,
      machineId,
      status: "FIRING",
      lastNotified: new Date(),
      details: details as any,
    },
    include: { rule: true, machine: true },
  });
  firingKeys.add(k);

  // Notify the dashboard in real time
  broadcastToDashboard({
    type: "alert.fired",
    machine_id: machineId,
    data: {
      id: alertState.id,
      ruleId: alertState.ruleId,
      ruleName: alertState.rule.name,
      severity,
      machineName: alertState.machine.name,
      details,
      firedAt: alertState.firedAt.toISOString(),
    },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: "ALERT_TRIGGERED",
      resource: "alert",
      resourceId: alertState.id,
      machineId,
      details: {
        ruleName: alertState.rule.name,
        severity,
        ...details,
      } as any,
    },
  });

  // Multi-channel notifications (Discord, Slack, Teams, Email, Webhook)
  // Dispatcher handles the modern channels (rule.channels JSON) + legacy
  // (notifyEmail, notifyWebhook). Fire-and-forget so as not to block the
  // alert pipeline — errors are logged by the dispatcher.
  dispatchNotifications(
    {
      id: alertState.rule.id,
      notifyEmail: alertState.rule.notifyEmail,
      notifyWebhook: alertState.rule.notifyWebhook,
      channels: alertState.rule.channels,
    },
    {
      ruleId: alertState.rule.id,
      ruleName: alertState.rule.name,
      severity: String(severity) as any,
      machineName: alertState.machine.name,
      machineId,
      conditionType: String(alertState.rule.conditionType),
      details,
      firedAt: alertState.firedAt.toISOString(),
    }
  ).then((results) => {
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.warn(
        `[AlertEngine] ${failed.length}/${results.length} channels failed for ${alertState.rule.name}:`,
        failed.map((f) => `${f.type}=${f.error}`).join(", ")
      );
    }
  });
}

async function resolveAlert(
  ruleId: string,
  machineId: string
): Promise<void> {
  const k = fkey(ruleId, machineId);
  // Negative cache: if not in the superset, nothing to resolve → 0 DB queries.
  if (!firingKeys.has(k)) return;

  const firing = await prisma.alertState.findFirst({
    where: {
      ruleId,
      machineId,
      status: { in: ["FIRING", "ACKNOWLEDGED"] },
    },
  });

  if (!firing) {
    // Stale key (resolved via the API for instance): we clean the cache.
    firingKeys.delete(k);
    return;
  }

  await prisma.alertState.update({
    where: { id: firing.id },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });
  firingKeys.delete(k);

  broadcastToDashboard({
    type: "alert.resolved",
    machine_id: machineId,
    data: { id: firing.id, ruleId },
  });

  await prisma.auditLog.create({
    data: {
      action: "ALERT_RESOLVED",
      resource: "alert",
      resourceId: firing.id,
      machineId,
      details: { ruleId, autoResolved: true } as any,
    },
  });
}

// ===================== Helpers =====================

function checkCondition(
  conditionType: AlertConditionType,
  threshold: number | null,
  metrics: any
): boolean {
  if (threshold == null) return false;

  switch (conditionType) {
    case "CPU_ABOVE":
      return (metrics.cpu_percent ?? 0) > threshold;
    case "MEMORY_ABOVE":
      return (metrics.memory_percent ?? 0) > threshold;
    case "DISK_ABOVE":
      return (metrics.disks ?? []).some(
        (d: any) => d.percent > threshold
      );
    case "LOAD_ABOVE":
      return (metrics.load_avg_1 ?? 0) > threshold;
    default:
      return false;
  }
}

function getCurrentValue(
  conditionType: AlertConditionType,
  metrics: any
): number {
  switch (conditionType) {
    case "CPU_ABOVE":
      return metrics.cpu_percent ?? 0;
    case "MEMORY_ABOVE":
      return metrics.memory_percent ?? 0;
    case "DISK_ABOVE":
      return Math.max(...(metrics.disks ?? []).map((d: any) => d.percent), 0);
    case "LOAD_ABOVE":
      return metrics.load_avg_1 ?? 0;
    default:
      return 0;
  }
}
