import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const rootDir = resolve(__dirname, "../../..");
const frontendSrc = resolve(rootDir, "frontend/src");

// Structural guardrails for the monitoring charts review:
// #1 honest long windows (SQL downsampling, no more take=100 ASC that only
// showed the 100 oldest points); #2 temporal X axis + gap-fill
// (visible gaps, never a straight line across an offline period).
describe("Metrics — SQL downsampling + temporal axis + gap-fill", () => {
  it("backend /metrics downsamples in SQL with an aligned bucket (no more take=limit)", () => {
    const c = readFileSync(resolve(backendSrc, "routes/metrics.ts"), "utf8");
    expect(c).toContain("$queryRaw");
    expect(c).toContain('floor(extract(epoch from "timestamp")');
    expect(c).toContain("GROUP BY bucket");
    expect(c).toContain("bucketSeconds");
    // the bug is removed: no more take(limit) pagination on the series
    expect(c).not.toContain("take: parseInt(limit");
  });

  it("backend /metrics/latest stays the last RAW point (findFirst desc, untouched)", () => {
    const c = readFileSync(resolve(backendSrc, "routes/metrics.ts"), "utf8");
    expect(c).toContain("metrics/latest");
    expect(c).toContain("findFirst");
    expect(c).toContain('orderBy: { timestamp: "desc" }');
  });

  it("chartTime centralizes the axis formats + the gap-fill grid (i18n Lot 9 resume point)", () => {
    const c = readFileSync(resolve(frontendSrc, "lib/chartTime.ts"), "utf8");
    expect(c).toContain("export function formatAxisTick");
    expect(c).toContain("export function formatAxisLabel");
    expect(c).toContain("export function buildTimeGrid");
    expect(c).toContain("export function alignToBucket");
  });

  it("MetricsChart: numeric temporal X axis + gap-fill + unconnected gaps", () => {
    const c = readFileSync(resolve(frontendSrc, "components/MetricsChart.tsx"), "utf8");
    expect(c).toContain("buildTimeGrid");
    expect(c).toContain('dataKey="timestamp"');
    expect(c).toContain('type="number"');
    expect(c).toContain("connectNulls={false}");
    expect(c).toContain("formatAxisTick");
    expect(c).toContain("formatAxisLabel");
    // no more hardcoded "HH:mm" string axis
    expect(c).not.toContain('dataKey="time"');
  });

  it("Compare: merge by aligned bucket + gap-fill (no more merge by HH:mm string)", () => {
    const c = readFileSync(resolve(frontendSrc, "pages/Compare.tsx"), "utf8");
    expect(c).toContain("alignToBucket");
    expect(c).toContain("buildTimeGrid");
    expect(c).toContain("connectNulls={false}");
    expect(c).not.toContain('toLocaleTimeString("fr-FR"');
  });
});
