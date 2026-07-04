import nodemailer from "nodemailer";
import { prisma } from "./database.js";

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

// Normalizes a raw settings value into an SmtpConfig. The UI persists the SMTP
// config under the "smtp" key with a "password" field (see Settings.tsx), so we
// read exactly that shape. (Historically this read "smtp_config"/"pass", which
// never matched the UI → alert emails silently never sent.)
function normalizeSmtpConfig(config: any): SmtpConfig | null {
  if (!config || !config.host || !config.user) return null;
  return {
    host: config.host,
    port: config.port || 587,
    user: config.user,
    password: config.password || "",
    from: config.from || config.user,
  };
}

async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const setting = await prisma.setting.findUnique({ where: { key: "smtp" } });
  if (!setting) return null;
  return normalizeSmtpConfig(setting.value);
}

export async function sendAlertEmail(
  to: string,
  alert: {
    ruleName: string;
    severity: string;
    machineName: string;
    details: Record<string, any>;
    firedAt: string;
  }
): Promise<void> {
  const config = await getSmtpConfig();
  if (!config) {
    console.warn("[Email] SMTP not configured, skipping email notification");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.password,
    },
  });

  const severityColors: Record<string, string> = {
    CRITICAL: "#ef4444",
    WARNING: "#f59e0b",
    INFO: "#3b82f6",
  };
  const color = severityColors[alert.severity] || "#6b7280";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1a1a2e; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="color: white; margin: 0;">&#x1f6a8; Nexus Alert</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
        <div style="background: ${color}15; border-left: 4px solid ${color}; padding: 12px; margin-bottom: 16px; border-radius: 4px;">
          <strong style="color: ${color};">${alert.severity}</strong> — ${alert.ruleName}
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px 0; color: #6b7280;">Machine</td><td style="padding: 8px 0; font-weight: bold;">${alert.machineName}</td></tr>
          <tr><td style="padding: 8px 0; color: #6b7280;">Condition</td><td style="padding: 8px 0;">${alert.details.conditionType || "N/A"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6b7280;">Value</td><td style="padding: 8px 0;">${alert.details.value ?? "N/A"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6b7280;">Threshold</td><td style="padding: 8px 0;">${alert.details.threshold ?? "N/A"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6b7280;">Date</td><td style="padding: 8px 0;">${new Date(alert.firedAt).toLocaleString("fr-FR")}</td></tr>
        </table>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">Sent by Nexus Infrastructure Manager</p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Nexus" <${config.from}>`,
      to,
      subject: `[${alert.severity}] ${alert.ruleName} — ${alert.machineName}`,
      html,
    });
    console.log(`[Email] Alert email sent to ${to}`);
  } catch (err: any) {
    console.error(`[Email] Failed to send: ${err.message}`);
  }
}

// Sends a test email using an EXPLICIT config (the values currently in the UI
// form, so the admin can validate SMTP before saving). Unlike sendAlertEmail,
// this THROWS on failure so the route can surface the real SMTP error. Recipient
// defaults to the from/user address (send-to-self).
export async function sendTestEmail(raw: unknown): Promise<{ to: string }> {
  const config = normalizeSmtpConfig(raw);
  if (!config) {
    throw new Error("SMTP host and user are required");
  }
  const to = config.from || config.user;

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });

  await transporter.sendMail({
    from: `"Nexus" <${config.from}>`,
    to,
    subject: "[Nexus] SMTP test",
    text: "This is a test email from Nexus. If you received it, your SMTP settings work.",
  });
  console.log(`[Email] Test email sent to ${to}`);
  return { to };
}
