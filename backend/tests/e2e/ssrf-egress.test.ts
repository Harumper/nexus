import { describe, it, expect, vi } from "vitest";

// NEXUS-WEB-AUTHZ-001 — BEHAVIORAL regression of the real path, run by CI.
//
// The structural GUARD (pentest) passed 10/10 while the real webhook sender
// still let a request go out to a private IP: undici skips the DNS `lookup` hook
// when the URL is already a literal IP → the private-range block (which lived at
// the lookup) was bypassed for http://10.0.0.1, http://169.254.169.254…
//
// This test exercises the REAL PATH (safeFetch + the exported sendWebhook
// function) and verifies that a private/metadata target is refused BEFORE any
// network attempt, with a [net-guard] error (not a "fetch failed"). If a future
// change re-disconnects safeFetch / assertSafeOutboundUrl, this test breaks — in CI.

// webhook.ts imports prisma (database.js); with customSecret, sendWebhook never
// queries it → an empty mock is enough to load the module without a DB.
vi.mock("../../src/services/database.js", () => ({ prisma: {} }));

import { safeFetch, assertSafeOutboundUrl } from "../../src/services/net-guard.js";
import { sendWebhook } from "../../src/services/webhook.js";

const PRIVATE_TARGETS = [
  "http://10.0.0.1/test", // RFC1918
  "http://169.254.169.254/latest/meta-data", // cloud metadata
  "http://127.0.0.1:6379/", // loopback (redis)
  "http://[::1]/", // literal IPv6 loopback
  "http://192.168.1.1/",
  "http://172.16.5.5/",
];

describe("WEB-AUTHZ-001 — SSRF egress on the real path (CI)", () => {
  it("assertSafeOutboundUrl blocks private/metadata literal IPs (sync, before I/O)", () => {
    for (const u of PRIVATE_TARGETS) {
      expect(() => assertSafeOutboundUrl(u), u).toThrow(/SSRF|blocked/i);
    }
    // a public literal IP stays allowed (no over-blocking)
    expect(() => assertSafeOutboundUrl("http://8.8.8.8/")).not.toThrow();
  });

  it("safeFetch refuses a private IP with a net-guard error (not a network failure)", async () => {
    for (const u of PRIVATE_TARGETS) {
      await expect(safeFetch(u), u).rejects.toThrow(/\[net-guard\].*SSRF/i);
    }
  });

  it("the REAL sendWebhook() refuses a private/metadata IP before sending", async () => {
    await expect(
      sendWebhook("http://10.0.0.1/test", { test: true }, "dummysecret"),
    ).rejects.toThrow(/\[net-guard\].*SSRF/i);
    await expect(
      sendWebhook("http://169.254.169.254/latest/meta-data", { test: true }, "dummysecret"),
    ).rejects.toThrow(/\[net-guard\].*SSRF/i);
  });
});
