import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const rootDir = resolve(__dirname, "../../..");
const frontendSrc = resolve(rootDir, "frontend/src");

// Garde-fous structurels pour la revue des graphes de monitoring :
// #1 fenêtres longues honnêtes (downsampling SQL, plus de take=100 ASC qui ne
// montrait que les 100 points les plus anciens) ; #2 axe X temporel + gap-fill
// (trous visibles, jamais une ligne droite à travers une période offline).
describe("Metrics — downsampling SQL + axe temporel + gap-fill", () => {
  it("backend /metrics downsample en SQL avec bucket aligné (plus de take=limit)", () => {
    const c = readFileSync(resolve(backendSrc, "routes/metrics.ts"), "utf8");
    expect(c).toContain("$queryRaw");
    expect(c).toContain('floor(extract(epoch from "timestamp")');
    expect(c).toContain("GROUP BY bucket");
    expect(c).toContain("bucketSeconds");
    // le bug est retiré : plus de pagination take(limit) sur la série
    expect(c).not.toContain("take: parseInt(limit");
  });

  it("backend /metrics/latest reste le dernier point BRUT (findFirst desc, intouché)", () => {
    const c = readFileSync(resolve(backendSrc, "routes/metrics.ts"), "utf8");
    expect(c).toContain("metrics/latest");
    expect(c).toContain("findFirst");
    expect(c).toContain('orderBy: { timestamp: "desc" }');
  });

  it("chartTime centralise les formats d'axe + la grille de gap-fill (point de reprise i18n Lot 9)", () => {
    const c = readFileSync(resolve(frontendSrc, "lib/chartTime.ts"), "utf8");
    expect(c).toContain("export function formatAxisTick");
    expect(c).toContain("export function formatAxisLabel");
    expect(c).toContain("export function buildTimeGrid");
    expect(c).toContain("export function alignToBucket");
  });

  it("MetricsChart : axe X temporel numérique + gap-fill + trous non reliés", () => {
    const c = readFileSync(resolve(frontendSrc, "components/MetricsChart.tsx"), "utf8");
    expect(c).toContain("buildTimeGrid");
    expect(c).toContain('dataKey="timestamp"');
    expect(c).toContain('type="number"');
    expect(c).toContain("connectNulls={false}");
    expect(c).toContain("formatAxisTick");
    expect(c).toContain("formatAxisLabel");
    // plus d'axe en chaîne "HH:mm" en dur
    expect(c).not.toContain('dataKey="time"');
  });

  it("Compare : fusion par bucket aligné + gap-fill (plus de fusion par chaîne HH:mm)", () => {
    const c = readFileSync(resolve(frontendSrc, "pages/Compare.tsx"), "utf8");
    expect(c).toContain("alignToBucket");
    expect(c).toContain("buildTimeGrid");
    expect(c).toContain("connectNulls={false}");
    expect(c).not.toContain('toLocaleTimeString("fr-FR"');
  });
});
