// Multi-channel notification dispatcher for alerts.
// Inspired by Nautilus but HMAC-signed for generic webhooks.

import { sendWebhook } from "./webhook.js";
import { sendAlertEmail } from "./email.js";
import { prisma } from "./database.js";
import { assertSafeOutboundUrl, safeFetch } from "./net-guard.js";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ChannelType = "DISCORD" | "SLACK" | "TEAMS" | "EMAIL" | "WEBHOOK";

export interface NotificationChannel {
  type: ChannelType;
  config: Record<string, unknown>;
}

export interface AlertEvent {
  ruleId: string;
  ruleName: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  machineName: string;
  machineId: string;
  conditionType: string;
  details: Record<string, any>;
  firedAt: string;
  isTest?: boolean;
}

export interface ChannelResult {
  type: ChannelType;
  success: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Discord
// ═══════════════════════════════════════════════════════════════

const DISCORD_COLORS = {
  INFO: 0x3498db,     // blue
  WARNING: 0xf39c12,  // orange
  CRITICAL: 0xe74c3c, // red
};

async function sendDiscord(webhookUrl: string, event: AlertEvent): Promise<void> {
  const color = DISCORD_COLORS[event.severity] ?? DISCORD_COLORS.WARNING;
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Machine", value: event.machineName, inline: true },
    { name: "Severity", value: event.severity, inline: true },
    { name: "Condition", value: event.conditionType, inline: true },
  ];

  // Contextual details depending on the condition type
  if (event.details.value !== undefined && event.details.threshold !== undefined) {
    fields.push({
      name: "Value",
      value: `${event.details.value} (threshold ${event.details.threshold})`,
      inline: false,
    });
  }
  if (event.details.failedServices?.length) {
    fields.push({
      name: "Failed services",
      value: event.details.failedServices.slice(0, 10).join(", "),
      inline: false,
    });
  }
  if (event.details.certs?.length) {
    fields.push({
      name: "Expiring certs",
      value: event.details.certs
        .slice(0, 5)
        .map((c: any) => `${c.subject || c.path}: ${c.days_remaining}d`)
        .join("\n"),
      inline: false,
    });
  }

  const payload = {
    username: "Nexus",
    embeds: [
      {
        title: event.isTest ? `🧪 [TEST] ${event.ruleName}` : `🚨 ${event.ruleName}`,
        color,
        fields,
        timestamp: event.firedAt,
        footer: { text: "Nexus" },
      },
    ],
  };

  await postJson(webhookUrl, payload, 10_000);
}

// ═══════════════════════════════════════════════════════════════
// Slack (legacy attachments — works with any incoming webhook)
// ═══════════════════════════════════════════════════════════════

const SLACK_COLORS = {
  INFO: "#3498db",
  WARNING: "warning",
  CRITICAL: "danger",
};

async function sendSlack(webhookUrl: string, event: AlertEvent): Promise<void> {
  const color = SLACK_COLORS[event.severity] ?? SLACK_COLORS.WARNING;
  const payload = {
    text: event.isTest
      ? `:test_tube: *[TEST]* ${event.ruleName}`
      : `:rotating_light: *${event.ruleName}*`,
    attachments: [
      {
        color,
        fields: [
          { title: "Machine", value: event.machineName, short: true },
          { title: "Severity", value: event.severity, short: true },
          { title: "Condition", value: event.conditionType, short: true },
          { title: "Details", value: formatDetails(event.details), short: false },
        ],
        footer: "Nexus",
        ts: Math.floor(new Date(event.firedAt).getTime() / 1000),
      },
    ],
  };
  await postJson(webhookUrl, payload, 10_000);
}

// ═══════════════════════════════════════════════════════════════
// Microsoft Teams (Adaptive Cards via incoming webhook)
// ═══════════════════════════════════════════════════════════════

const TEAMS_COLORS = {
  INFO: "0078D4",
  WARNING: "FFA500",
  CRITICAL: "D13438",
};

async function sendTeams(webhookUrl: string, event: AlertEvent): Promise<void> {
  const color = TEAMS_COLORS[event.severity] ?? TEAMS_COLORS.WARNING;
  const payload = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: color,
    summary: event.ruleName,
    title: event.isTest ? `[TEST] ${event.ruleName}` : event.ruleName,
    sections: [
      {
        activityTitle: `Severity: ${event.severity}`,
        facts: [
          { name: "Machine", value: event.machineName },
          { name: "Condition", value: event.conditionType },
          { name: "Details", value: formatDetails(event.details) },
          { name: "Date", value: event.firedAt },
        ],
      },
    ],
  };
  await postJson(webhookUrl, payload, 10_000);
}

// ═══════════════════════════════════════════════════════════════
// Custom email (per-rule recipients, override the global email)
// ═══════════════════════════════════════════════════════════════

async function sendChannelEmail(
  recipients: string[],
  event: AlertEvent
): Promise<void> {
  for (const to of recipients) {
    await sendAlertEmail(to, {
      ruleName: event.ruleName,
      severity: event.severity,
      machineName: event.machineName,
      details: event.details,
      firedAt: event.firedAt,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Generic webhook (HMAC-signed)
// ═══════════════════════════════════════════════════════════════

async function sendGenericWebhook(
  url: string,
  hmacSecret: string | undefined,
  event: AlertEvent
): Promise<void> {
  // If hmacSecret is provided, we use it to sign. Otherwise we fall back to the
  // global setting (already handled by sendWebhook).
  await sendWebhook(url, {
    event: event.isTest ? "alert.test" : "alert.fired",
    alert: {
      id: event.ruleId,
      ruleName: event.ruleName,
      severity: event.severity,
      machineName: event.machineName,
      machineId: event.machineId,
      conditionType: event.conditionType,
      details: event.details,
      firedAt: event.firedAt,
    },
    timestamp: new Date().toISOString(),
  }, hmacSecret);
}

// ═══════════════════════════════════════════════════════════════
// Main dispatcher
// ═══════════════════════════════════════════════════════════════

/**
 * Dispatches an alert to all channels configured for the rule.
 * Also resolves legacy channels (notifyEmail, notifyWebhook).
 */
export async function dispatchNotifications(
  rule: {
    id: string;
    notifyEmail: boolean;
    notifyWebhook: string | null;
    channels: any;
  },
  event: AlertEvent
): Promise<ChannelResult[]> {
  const results: ChannelResult[] = [];
  const promises: Array<Promise<ChannelResult>> = [];

  // Modern channels (JSON array)
  const channels: NotificationChannel[] = Array.isArray(rule.channels) ? rule.channels : [];
  for (const channel of channels) {
    promises.push(executeChannel(channel, event));
  }

  // Legacy: notifyEmail (uses the alert_email setting)
  if (rule.notifyEmail) {
    promises.push(
      (async (): Promise<ChannelResult> => {
        try {
          const setting = await prisma.setting.findUnique({ where: { key: "alert_email" } });
          const email =
            typeof setting?.value === "string"
              ? setting.value
              : (setting?.value as any)?.value;
          if (!email) {
            return { type: "EMAIL", success: false, error: "alert_email setting missing" };
          }
          await sendChannelEmail([email], event);
          return { type: "EMAIL", success: true };
        } catch (err: any) {
          return { type: "EMAIL", success: false, error: err?.message || "email failed" };
        }
      })()
    );
  }

  // Legacy: notifyWebhook (HMAC signed)
  if (rule.notifyWebhook) {
    promises.push(
      (async (): Promise<ChannelResult> => {
        try {
          await sendGenericWebhook(rule.notifyWebhook!, undefined, event);
          return { type: "WEBHOOK", success: true };
        } catch (err: any) {
          return { type: "WEBHOOK", success: false, error: err?.message || "webhook failed" };
        }
      })()
    );
  }

  const all = await Promise.all(promises);
  results.push(...all);
  return results;
}

async function executeChannel(
  channel: NotificationChannel,
  event: AlertEvent
): Promise<ChannelResult> {
  try {
    switch (channel.type) {
      case "DISCORD": {
        const url = String(channel.config.webhookUrl || "");
        if (!url) throw new Error("webhookUrl missing");
        await sendDiscord(url, event);
        return { type: "DISCORD", success: true };
      }
      case "SLACK": {
        const url = String(channel.config.webhookUrl || "");
        if (!url) throw new Error("webhookUrl missing");
        await sendSlack(url, event);
        return { type: "SLACK", success: true };
      }
      case "TEAMS": {
        const url = String(channel.config.webhookUrl || "");
        if (!url) throw new Error("webhookUrl missing");
        await sendTeams(url, event);
        return { type: "TEAMS", success: true };
      }
      case "EMAIL": {
        const recipients = Array.isArray(channel.config.recipients)
          ? (channel.config.recipients as string[])
          : [];
        if (recipients.length === 0) throw new Error("recipients missing");
        await sendChannelEmail(recipients, event);
        return { type: "EMAIL", success: true };
      }
      case "WEBHOOK": {
        const url = String(channel.config.url || "");
        if (!url) throw new Error("url missing");
        const hmac = channel.config.hmacSecret ? String(channel.config.hmacSecret) : undefined;
        await sendGenericWebhook(url, hmac, event);
        return { type: "WEBHOOK", success: true };
      }
      default:
        return {
          type: channel.type,
          success: false,
          error: `Unknown channel type: ${channel.type}`,
        };
    }
  } catch (err: any) {
    return {
      type: channel.type,
      success: false,
      error: err?.message || "unknown error",
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function formatDetails(details: Record<string, any>): string {
  const parts: string[] = [];
  if (details.value !== undefined && details.threshold !== undefined) {
    parts.push(`${details.value} (threshold ${details.threshold})`);
  }
  if (details.count !== undefined) parts.push(`Count: ${details.count}`);
  if (details.failedServices?.length) {
    parts.push(`Services: ${details.failedServices.slice(0, 5).join(", ")}`);
  }
  if (details.minDays !== undefined) parts.push(`Min days: ${details.minDays}`);
  if (parts.length === 0) return JSON.stringify(details);
  return parts.join(" · ");
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<void> {
  // WEB-AUTHZ-001: Slack/Discord/Teams/generic webhook URLs are operator-supplied
  // config — guard against SSRF (private/metadata ranges, rebinding, redirects).
  assertSafeOutboundUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tests a rule by sending a test event to all its channels.
 */
export async function testAlertRule(ruleId: string): Promise<ChannelResult[]> {
  const rule = await prisma.alertRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new Error("Rule not found");

  const event: AlertEvent = {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity as any,
    machineName: "test-machine",
    machineId: "test",
    conditionType: rule.conditionType,
    details: {
      test: true,
      threshold: rule.threshold,
      value: rule.threshold,
      message: "This is a notification test from Nexus",
    },
    firedAt: new Date().toISOString(),
    isTest: true,
  };

  return dispatchNotifications(rule, event);
}
