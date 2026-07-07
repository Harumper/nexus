import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const rootDir = resolve(__dirname, "../../..");
const frontendSrc = resolve(rootDir, "frontend/src");

// Nexus keeps only a LIVE in-memory metrics window; long-term history is
// Prometheus/Grafana (per-machine nexus_machine_* gauges). These guards ensure the
// persisted TSDB is gone and the live buffer + temporal axis / gap-fill are in place.
describe("Metrics — live in-memory buffer (no persisted TSDB)", () => {
  it("has an in-memory buffer service (push/getSeries/getLatest/getFleetLatest/evict)", async () => {
    const buf: any = await import("../../src/services/metrics-buffer.js");
    for (const fn of ["pushMetric", "getSeries", "getLatest", "getFleetLatest", "evictMachine"]) {
      expect(typeof buf[fn]).toBe("function");
    }
  });

  it("processMetrics feeds the buffer, not the DB", () => {
    const c = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(c).toContain("pushMetric");
    expect(c).not.toContain("prisma.metric.create");
  });

  it("/metrics + /metrics/latest read the buffer (no SQL downsampling)", () => {
    const c = readFileSync(resolve(backendSrc, "routes/metrics.ts"), "utf8");
    expect(c).toContain("getSeries");
    expect(c).toContain("getLatest");
    expect(c).not.toContain("$queryRaw");
    expect(c).not.toContain("prisma.metric");
  });

  it("fleet summary reads the buffer; /fleet/trends is gone", () => {
    const c = readFileSync(resolve(backendSrc, "routes/fleet.ts"), "utf8");
    expect(c).toContain("getFleetLatest");
    expect(c).not.toContain('"/api/fleet/trends"');
    expect(c).not.toContain("$queryRaw");
  });

  it("the Metric table is dropped by a migration", () => {
    const dir = resolve(backendSrc, "../prisma/migrations");
    const dropped = readdirSync(dir).some((d) => {
      const p = resolve(dir, d, "migration.sql");
      return existsSync(p) && /DROP TABLE.*"Metric"/i.test(readFileSync(p, "utf8"));
    });
    expect(dropped).toBe(true);
  });

  it("frontend live charts keep the temporal axis + gap-fill (chartTime)", () => {
    expect(readFileSync(resolve(frontendSrc, "lib/chartTime.ts"), "utf8")).toContain(
      "export function buildTimeGrid"
    );
    const mc = readFileSync(resolve(frontendSrc, "components/MetricsChart.tsx"), "utf8");
    expect(mc).toContain("buildTimeGrid");
    expect(mc).toContain('dataKey="timestamp"');
    expect(mc).toContain("connectNulls={false}");
    const cp = readFileSync(resolve(frontendSrc, "pages/Compare.tsx"), "utf8");
    expect(cp).toContain("buildTimeGrid");
    expect(cp).toContain("connectNulls={false}");
  });
});
