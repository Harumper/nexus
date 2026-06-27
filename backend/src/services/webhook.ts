import { createHmac } from "node:crypto";
import { prisma } from "./database.js";
import { assertSafeOutboundUrl, safeFetch } from "./net-guard.js";

export async function sendWebhook(
  url: string,
  payload: object,
  customSecret?: string,
): Promise<void> {
  let secret: string;
  if (customSecret) {
    secret = customSecret;
  } else {
    // Get or generate webhook secret global
    let secretSetting = await prisma.setting.findUnique({ where: { key: "webhook_secret" } });
    if (!secretSetting) {
      const { randomBytes } = await import("node:crypto");
      const generated = randomBytes(32).toString("hex");
      secretSetting = await prisma.setting.upsert({
        where: { key: "webhook_secret" },
        update: { value: generated },
        create: { key: "webhook_secret", value: generated },
      });
    }
    secret = typeof secretSetting.value === "string" ? secretSetting.value : String(secretSetting.value);
  }

  // WEB-AUTHZ-001: fail fast on a hostile webhook URL (scheme/credentials) before
  // any work; safeFetch additionally pins the connection to a validated address.
  assertSafeOutboundUrl(url);

  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  // WEB-AUTHZ-002: authenticate the timestamp, not just the body. HMAC over
  // `${timestamp}.${body}` (Stripe-style) so a receiver can bind the timestamp to
  // the signature and reject replays. Header: `t=<ts>,v1=<hmac>`.
  const signedPayload = `${timestamp}.${body}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  const signatureHeader = `t=${timestamp},v1=${signature}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexus-Signature": signatureHeader,
        "X-Nexus-Timestamp": timestamp,
        "User-Agent": "Nexus-Webhook/1.0",
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[Webhook] POST ${url} returned ${response.status}`);
    } else {
      console.log(`[Webhook] POST ${url} → ${response.status}`);
    }
  } catch (err: any) {
    console.error(`[Webhook] Failed to POST ${url}: ${err.message}`);
    // Retry once after 2s
    try {
      await new Promise(r => setTimeout(r, 2000));
      await safeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nexus-Signature": signatureHeader,
          "X-Nexus-Timestamp": timestamp,
          "User-Agent": "Nexus-Webhook/1.0",
        },
        body,
      });
    } catch {
      console.error(`[Webhook] Retry also failed for ${url}`);
    }
  }
}
