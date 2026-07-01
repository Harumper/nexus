import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { registerPrometheusEndpoint } from "../../src/services/prometheus.js";

// NEXUS-WEB-AUTHZ-005 — optional auth for /metrics, run by CI.
// Exercises the REAL handler (registerPrometheusEndpoint, the same as main()), not a
// copy — via app.inject() (no real port). Proves both modes:
//  - METRICS_TOKEN absent → /metrics open (no regression; network-scoping remains
//    the default protection).
//  - METRICS_TOKEN set → bearer required, fail-closed (absent/wrong → 401; correct → 200).

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

  it("METRICS_TOKEN absent → /metrics open (no regression)", async () => {
    delete process.env.METRICS_TOKEN;
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/nexus_|# HELP/); // real Prometheus body
    await app.close();
  });

  it("METRICS_TOKEN set + NO Authorization → 401", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("METRICS_TOKEN set + WRONG bearer → 401", async () => {
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

  it("METRICS_TOKEN set + correct bearer → 200 + metrics", async () => {
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
