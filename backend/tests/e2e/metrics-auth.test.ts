import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { registerPrometheusEndpoint } from "../../src/services/prometheus.js";

// NEXUS-WEB-AUTHZ-005 — auth optionnelle de /metrics, lancée par le CI.
// Exerce le VRAI handler (registerPrometheusEndpoint, le même que main()), pas une
// copie — via app.inject() (pas de port réel). Prouve les deux modes :
//  - METRICS_TOKEN absent → /metrics ouvert (pas de régression ; le network-scoping
//    reste la protection par défaut).
//  - METRICS_TOKEN défini → bearer requis, fail-closed (absent/faux → 401 ; bon → 200).

async function makeApp() {
  const app = Fastify({ logger: false });
  registerPrometheusEndpoint(app);
  await app.ready();
  return app;
}

const TOKEN = "test-metrics-token-0123456789abcdef0123456789abcdef";

describe("WEB-AUTHZ-005 — /metrics token auth", () => {
  const prev = process.env.METRICS_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prev;
  });

  it("METRICS_TOKEN absent → /metrics ouvert (pas de régression)", async () => {
    delete process.env.METRICS_TOKEN;
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/nexus_|# HELP/); // corps Prometheus réel
    await app.close();
  });

  it("METRICS_TOKEN défini + AUCUN Authorization → 401", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("METRICS_TOKEN défini + bearer FAUX → 401", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("METRICS_TOKEN défini + bon bearer → 200 + métriques", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/nexus_|# HELP/);
    await app.close();
  });
});
