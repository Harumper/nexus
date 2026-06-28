import { describe, it, expect, vi } from "vitest";

// NEXUS-WEB-AUTHZ-001 — régression COMPORTEMENTALE du chemin réel, lancée par le CI.
//
// Le GUARD structurel (pentest) passait à 10/10 alors que le sender webhook réel
// laissait partir une requête vers une IP privée : undici saute le hook DNS
// `lookup` quand l'URL est déjà une IP littérale → le blocage de plage privée
// (qui vivait au lookup) était contourné pour http://10.0.0.1, http://169.254.169.254…
//
// Ce test exerce le CHEMIN RÉEL (safeFetch + la fonction exportée sendWebhook) et
// vérifie qu'une cible privée/métadonnées est refusée AVANT toute tentative réseau,
// avec une erreur [net-guard] (pas un "fetch failed"). Si une future modif
// re-débranche safeFetch / assertSafeOutboundUrl, ce test casse — en CI.

// webhook.ts importe prisma (database.js) ; avec customSecret, sendWebhook ne le
// requête jamais → un mock vide suffit à charger le module hors DB.
vi.mock("../../src/services/database.js", () => ({ prisma: {} }));

import { safeFetch, assertSafeOutboundUrl } from "../../src/services/net-guard.js";
import { sendWebhook } from "../../src/services/webhook.js";

const PRIVATE_TARGETS = [
  "http://10.0.0.1/test", // RFC1918
  "http://169.254.169.254/latest/meta-data", // métadonnées cloud
  "http://127.0.0.1:6379/", // loopback (redis)
  "http://[::1]/", // IPv6 loopback littéral
  "http://192.168.1.1/",
  "http://172.16.5.5/",
];

describe("WEB-AUTHZ-001 — SSRF egress sur le chemin réel (CI)", () => {
  it("assertSafeOutboundUrl bloque les IP littérales privées/métadonnées (sync, avant I/O)", () => {
    for (const u of PRIVATE_TARGETS) {
      expect(() => assertSafeOutboundUrl(u), u).toThrow(/SSRF|blocked/i);
    }
    // une IP publique littérale reste autorisée (pas de sur-blocage)
    expect(() => assertSafeOutboundUrl("http://8.8.8.8/")).not.toThrow();
  });

  it("safeFetch refuse une IP privée avec une erreur net-guard (pas un échec réseau)", async () => {
    for (const u of PRIVATE_TARGETS) {
      await expect(safeFetch(u), u).rejects.toThrow(/\[net-guard\].*SSRF/i);
    }
  });

  it("la VRAIE sendWebhook() refuse une IP privée/métadonnées avant l'envoi", async () => {
    await expect(
      sendWebhook("http://10.0.0.1/test", { test: true }, "dummysecret"),
    ).rejects.toThrow(/\[net-guard\].*SSRF/i);
    await expect(
      sendWebhook("http://169.254.169.254/latest/meta-data", { test: true }, "dummysecret"),
    ).rejects.toThrow(/\[net-guard\].*SSRF/i);
  });
});
