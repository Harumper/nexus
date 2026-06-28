import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");

describe("Prometheus /metrics Endpoint", () => {
  it("should have prometheus service file", () => {
    const path = resolve(backendSrc, "services/prometheus.ts");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("prom-client");
    expect(content).toContain("collectDefaultMetrics");
    expect(content).toContain("nexus_http_requests_total");
    expect(content).toContain("nexus_ws_agent_connections");
    expect(content).toContain("nexus_machines_total");
    expect(content).toContain("nexus_machine_cpu_percent");
  });

  it("wires the /metrics route (registerPrometheusEndpoint) — handler in prometheus.ts", () => {
    // WEB-AUTHZ-005 : le handler /metrics (avec garde token) est extrait dans
    // prometheus.ts pour être testable en CI (voir metrics-auth.test.ts) ; index.ts
    // l'enregistre via registerPrometheusEndpoint(app).
    const index = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(index).toContain("registerPrometheusEndpoint(app)");
    const prom = readFileSync(resolve(backendSrc, "services/prometheus.ts"), "utf8");
    expect(prom).toContain('"/metrics"');
    expect(prom).toContain("register.metrics()");
    expect(prom).toContain("register.contentType");
    expect(prom).toContain("timingSafeEqual"); // garde bearer temps constant
  });

  it("should have HTTP request tracking hook", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("onResponse");
    expect(content).toContain("httpRequestsTotal");
    expect(content).toContain("httpRequestDuration");
  });

  it("should update machine metrics on WS metrics report", () => {
    const content = readFileSync(resolve(backendSrc, "websocket/handler.ts"), "utf8");
    expect(content).toContain("updateMachineMetrics");
  });

  it("should increment action counters", () => {
    const dispatcher = readFileSync(resolve(backendSrc, "services/action-dispatcher.ts"), "utf8");
    const handler = readFileSync(resolve(backendSrc, "websocket/handler.ts"), "utf8");
    expect(dispatcher).toContain("actionsDispatched.inc()");
    expect(handler).toContain("actionsFailed.inc()");
  });

  it("should have fleet metrics refresh interval", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("refreshFleetMetrics");
    expect(content).toContain("stopFleetMetrics");
  });

  it("should export all required gauges and counters", async () => {
    const mod = await import("../../src/services/prometheus.js");
    expect(typeof mod.register).toBe("object");
    expect(typeof mod.httpRequestsTotal).toBe("object");
    expect(typeof mod.httpRequestDuration).toBe("object");
    expect(typeof mod.wsAgentConnections).toBe("object");
    expect(typeof mod.machinesTotal).toBe("object");
    expect(typeof mod.machineCpu).toBe("object");
    expect(typeof mod.updateMachineMetrics).toBe("function");
    expect(typeof mod.refreshFleetMetrics).toBe("function");
  });
});

describe("Metrics Retention & Cleanup", () => {
  it("should have metrics-cleanup service", () => {
    const path = resolve(backendSrc, "services/metrics-cleanup.ts");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("metrics_retention_days");
    expect(content).toContain("deleteMany");
    expect(content).toContain("MachineEvent");
    expect(content).toContain("auditLog");
    expect(content).toContain("alertState");
  });

  it("should have cleanup interval in index.ts", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("runMetricsCleanup");
    expect(content).toContain("stopMetricsCleanup");
  });

  it("should support retention = 0 (no DB storage)", () => {
    const content = readFileSync(resolve(backendSrc, "services/metrics-cleanup.ts"), "utf8");
    expect(content).toContain("retentionDays === 0");
  });

  it("should export runMetricsCleanup function", async () => {
    const mod = await import("../../src/services/metrics-cleanup.js");
    expect(typeof mod.runMetricsCleanup).toBe("function");
  });
});
