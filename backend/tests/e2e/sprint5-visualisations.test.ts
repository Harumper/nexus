import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const agentDir = resolve(__dirname, "../../../agent");
const frontendSrc = resolve(__dirname, "../../../frontend/src");

describe("Phase 6.1 — Process Kill Action", () => {
  it("should have process_kill.go agent action", () => {
    const path = resolve(agentDir, "internal/actions/process_kill.go");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain('"process.kill"');
    expect(content).toContain('"scripts"');
    expect(content).toContain("SIGTERM");
    expect(content).toContain("SIGKILL");
    expect(content).toContain("/bin/kill");
    expect(content).toContain("pid");
  });

  it("should reject PID <= 1", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/process_kill.go"), "utf8");
    expect(content).toMatch(/pid\s*<=?\s*1/);
  });
});

describe("Phase 6.1 — Network Charts in MetricsChart", () => {
  it("should have network charts with Recharts", () => {
    const content = readFileSync(resolve(frontendSrc, "components/MetricsChart.tsx"), "utf8");
    expect(content).toContain("networkIn");
    expect(content).toContain("networkOut");
    expect(content).toContain("KB/s");
    // i18n : labels réseau externalisés en clés metricsChart:charts.network* (FR dans le JSON).
    expect(content).toContain("charts.networkIn");
    const frMetrics = readFileSync(resolve(frontendSrc, "i18n/locales/fr/metricsChart.json"), "utf8");
    expect(frMetrics).toContain("seau"); // "Réseau"
  });
});

describe("Phase 6.2 — Process List Component", () => {
  it("should have ProcessList component", () => {
    const path = resolve(frontendSrc, "components/ProcessList.tsx");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("ProcessList");
    expect(content).toContain("system.processes");
    expect(content).toContain("process.kill");
    expect(content).toContain("SIGTERM");
    expect(content).toContain("dispatchActionSync");
    expect(content).toContain("top_cpu");
    expect(content).toContain("top_memory");
  });

  it("should be integrated in MachineDetail", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/MachineDetail.tsx"), "utf8");
    expect(content).toContain("ProcessList");
    expect(content).toContain("machineId");
  });
});

describe("Phase 6.3 — Compare Page", () => {
  it("should have Compare page with LineChart", () => {
    const path = resolve(frontendSrc, "pages/Compare.tsx");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("LineChart");
    expect(content).toContain("recharts");
    expect(content).toContain("selectedIds");
    expect(content).toContain("getMachines");
    expect(content).toContain("getMetrics");
    // i18n : le titre est externalisé en clé common:nav.compare ; le label FR
    // "Comparer" vit désormais dans le fichier de langue.
    expect(content).toContain("common:nav.compare");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/common.json"), "utf8");
    expect(fr).toContain("Comparer");
  });

  it("should limit selection to 3 machines", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/Compare.tsx"), "utf8");
    expect(content).toMatch(/length\s*<\s*3/);
  });

  it("should have Compare route in App", () => {
    const content = readFileSync(resolve(frontendSrc, "App.tsx"), "utf8");
    expect(content).toContain("/compare");
    expect(content).toContain("Compare");
  });

  it("should have Compare nav item in Layout", () => {
    const content = readFileSync(resolve(frontendSrc, "components/Layout.tsx"), "utf8");
    expect(content).toContain("/compare");
    // i18n : le label du nav est externalisé en clé `nav.compare` (defaultNS "common").
    // On vérifie la clé câblée côté composant + la traduction FR dans le fichier de langue.
    expect(content).toContain("nav.compare");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/common.json"), "utf8");
    expect(fr).toContain("Comparer");
  });
});
