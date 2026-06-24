import { prisma } from "./database.js";
import { broadcastToDashboard } from "../websocket/dashboard.js";
import { dispatchActionSync } from "./action-sync.js";
import { dispatchNotifications } from "./notifications.js";
import type { AlertConditionType, AlertSeverity } from "@prisma/client";

// Conditions qui necessitent un poll actif (dispatch action vers l'agent)
const HEALTH_CHECK_CONDITIONS: AlertConditionType[] = [
  "SERVICE_FAILED",
  "TIMER_FAILED",
  "CRON_FAILED",
  "UPDATES_AVAILABLE",
];

// Conditions qui necessitent un scan SSL (moins frequent, plus lourd)
const CERT_CHECK_CONDITIONS: AlertConditionType[] = ["CERT_EXPIRING"];

// Condition de posture : evaluee sur le DERNIER SecurityScan persiste (pas de
// poll agent — Lynis est trop lent). Declenchee aussi apres chaque audit.
const HARDENING_CHECK_CONDITIONS: AlertConditionType[] = ["HARDENING_INDEX_BELOW"];

// ===================== Cache des alertes actives =====================
// Set en mémoire des (ruleId:machineId) actuellement FIRING/ACKNOWLEDGED.
// C'est un SUPERSET de l'état DB (initialisé au boot, alimenté par fireAlert).
// Permet à resolveAlert/fireAlert d'éviter un findFirst par (règle×machine×cycle)
// quand rien n'est en alerte — le cas ultra-majoritaire sur le chemin chaud
// (evaluateMetrics tourne à chaque rapport métrique × N machines).
const firingKeys = new Set<string>();
const fkey = (ruleId: string, machineId: string) => `${ruleId}:${machineId}`;

// À appeler au démarrage du backend : recharge l'état FIRING depuis la DB.
export async function initAlertState(): Promise<void> {
  firingKeys.clear();
  const active = await prisma.alertState.findMany({
    where: { status: { in: ["FIRING", "ACKNOWLEDGED"] } },
    select: { ruleId: true, machineId: true },
  });
  for (const a of active) firingKeys.add(fkey(a.ruleId, a.machineId));
  console.log(`[AlertEngine] ${firingKeys.size} alerte(s) active(s) chargée(s) en cache`);
}

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

// ===================== Health checks periodique (services/timers/updates) =====================

/**
 * Pour chaque machine ONLINE avec au moins une regle SERVICE_FAILED/TIMER_FAILED/
 * UPDATES_AVAILABLE active, dispatche system.health_summary et evalue les regles.
 */
export async function evaluateHealthAlerts(): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: {
      enabled: true,
      conditionType: { in: HEALTH_CHECK_CONDITIONS },
    },
  });
  if (rules.length === 0) return;

  // Collecter les machineIds concernees (si machineIds vide = toutes)
  const needAllMachines = rules.some((r) => r.machineIds.length === 0);
  const specificIds = new Set(rules.flatMap((r) => r.machineIds));

  const machines = await prisma.machine.findMany({
    where: {
      status: "ONLINE",
      type: "AGENT", // Les probes n'ont pas ces actions
      ...(needAllMachines ? {} : { id: { in: Array.from(specificIds) } }),
    },
    select: { id: true, name: true },
  });

  // Dispatcher en parallele avec concurrence limitee (10 machines a la fois)
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
          // Ignore silently : la machine peut etre offline entre temps
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
      // Filtre optionnel par pattern (nom de service)
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
      // Fire si count > threshold (ex: threshold=0 -> au moindre update)
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

// ===================== Cert expiration scan (toutes les 6h) =====================

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
      type: "AGENT",
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
            // Fire si au moins un cert expire dans <= threshold jours
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
            // expiring est utilise pour logging mais pas pour le trigger
            void expiring;
          }
        } catch (err) {
          // Ignore
        }
      })
    );
  }
}

// ===================== Posture de durcissement =====================

// Evalue les regles HARDENING_INDEX_BELOW contre le DERNIER SecurityScan
// persiste de chaque machine ciblee. Pas de poll agent (lecture DB only) :
// appelable frequemment et apres chaque audit. machineId optionnel = scope.
export async function evaluateHardeningAlerts(machineId?: string): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true, conditionType: { in: HARDENING_CHECK_CONDITIONS } },
  });
  if (rules.length === 0) return;

  // Machines ciblees : si machineId fourni, on se limite a elle.
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
      // On ne declenche que si on a un indice valide (>= 0) sous le seuil.
      // Indice -1 (Lynis sans indice) ou pas de scan -> ne rien declencher.
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
  // Si la clé n'est pas dans le cache (superset), il n'y a certainement pas
  // d'alerte active : on saute le findFirst et on crée directement.
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
  firingKeys.add(k);

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

  // Multi-channel notifications (Discord, Slack, Teams, Email, Webhook)
  // Dispatcher gere les channels modernes (rule.channels JSON) + legacy
  // (notifyEmail, notifyWebhook). Fire-and-forget pour ne pas bloquer le
  // pipeline d'alertes — les erreurs sont loggees par le dispatcher.
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
  // Négative-cache : si pas dans le superset, rien à résoudre → 0 requête DB.
  if (!firingKeys.has(k)) return;

  const firing = await prisma.alertState.findFirst({
    where: {
      ruleId,
      machineId,
      status: { in: ["FIRING", "ACKNOWLEDGED"] },
    },
  });

  if (!firing) {
    // Clé stale (résolue via l'API p.ex.) : on nettoie le cache.
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
