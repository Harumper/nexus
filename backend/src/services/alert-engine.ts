import { prisma } from "./database.js";
import { broadcastToDashboard } from "../websocket/dashboard.js";
import type { AlertConditionType, AlertSeverity } from "@prisma/client";

// ===================== Évaluation des métriques entrantes =====================

export async function evaluateMetrics(
  machineId: string,
  metrics: {
    cpu_percent?: number;
    memory_percent?: number;
    disks?: Array<{ percent: number; mountpoint: string }>;
    load_avg_1?: number;
  }
): Promise<void> {
  // Récupérer toutes les règles actives qui concernent cette machine
  const rules = await prisma.alertRule.findMany({
    where: {
      enabled: true,
      OR: [
        { machineIds: { isEmpty: true } }, // Toutes les machines
        { machineIds: { has: machineId } }, // Cette machine spécifiquement
      ],
    },
  });

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

// ===================== Vérification machines offline =====================

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

    // Machines qui devraient être en ligne mais ne le sont plus
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

    // Résoudre les alertes pour les machines revenues en ligne
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

// ===================== Fire / Resolve =====================

async function fireAlert(
  ruleId: string,
  machineId: string,
  severity: AlertSeverity,
  details: Record<string, any>
): Promise<void> {
  // Vérifier si déjà en cours
  const existing = await prisma.alertState.findFirst({
    where: {
      ruleId,
      machineId,
      status: { in: ["FIRING", "ACKNOWLEDGED"] },
    },
    include: { rule: true },
  });

  if (existing) {
    // Vérifier le cooldown
    if (
      existing.lastNotified &&
      Date.now() - existing.lastNotified.getTime() < (existing.rule.cooldownSeconds * 1000)
    ) {
      return; // Encore en cooldown
    }

    // Mettre à jour la dernière notification
    await prisma.alertState.update({
      where: { id: existing.id },
      data: { lastNotified: new Date(), details: details as any },
    });
    return;
  }

  // Créer une nouvelle alerte
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

  // Notifier le dashboard en temps réel
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

  // Webhook notification
  if (alertState.rule.notifyWebhook) {
    import("./webhook.js").then(({ sendWebhook }) => {
      sendWebhook(alertState.rule.notifyWebhook!, {
        event: "alert.fired",
        alert: {
          id: alertState.id,
          ruleName: alertState.rule.name,
          severity,
          machineName: alertState.machine.name,
          details,
          firedAt: alertState.firedAt.toISOString(),
        },
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    });
  }

  // Email notification
  if (alertState.rule.notifyEmail) {
    import("./email.js").then(({ sendAlertEmail }) => {
      // Get email from settings or rule
      prisma.setting.findUnique({ where: { key: "alert_email" } }).then(setting => {
        const email = typeof setting?.value === "string" ? setting.value : (setting?.value as any)?.value;
        if (email) {
          sendAlertEmail(email, {
            ruleName: alertState.rule.name,
            severity: String(severity),
            machineName: alertState.machine.name,
            details,
            firedAt: alertState.firedAt.toISOString(),
          }).catch(() => {});
        }
      });
    });
  }
}

async function resolveAlert(
  ruleId: string,
  machineId: string
): Promise<void> {
  const firing = await prisma.alertState.findFirst({
    where: {
      ruleId,
      machineId,
      status: { in: ["FIRING", "ACKNOWLEDGED"] },
    },
  });

  if (!firing) return;

  await prisma.alertState.update({
    where: { id: firing.id },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });

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
