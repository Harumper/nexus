import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const frontendSrc = resolve(__dirname, "../../../frontend/src");

describe("Phase 3 — Fleet Summary API", () => {
  it("should have fleet route file with summary and trends endpoints", () => {
    const path = resolve(backendSrc, "routes/fleet.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("fleetRoutes");
    expect(content).toContain('"/api/fleet/summary"');
    expect(content).toContain('"/api/fleet/trends"');
    expect(content).toContain("avgCpu");
    expect(content).toContain("topCpu");
    expect(content).toContain("healthScore");
    expect(content).toContain("health_threshold_cpu");
  });

  it("should export fleet routes function", async () => {
    const mod = await import("../../src/routes/fleet.js");
    expect(typeof mod.fleetRoutes).toBe("function");
  });

  it("should be registered in index.ts", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("fleetRoutes");
  });
});

describe("Phase 3 — Dashboard Redesign", () => {
  it("should have redesigned Dashboard with fleet sections", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/Dashboard.tsx"), "utf8");
    // Fleet summary state
    expect(content).toContain("fleetSummary");
    expect(content).toContain("fleetTrends");
    // Recharts imports
    expect(content).toContain("AreaChart");
    expect(content).toContain("recharts");
    // New stat cards
    expect(content).toContain("alertCount");
    expect(content).toContain("rebootCount");
    // Top consumers tabs
    expect(content).toContain("activeTab");
    expect(content).toContain("topCpu");
    // Health score
    expect(content).toContain("healthScore");
  });

  it("should have fleet API methods in api.ts", () => {
    const content = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(content).toContain("getFleetSummary");
    expect(content).toContain("getFleetTrends");
    expect(content).toContain("fleet/summary");
  });
});

describe("Phase 3 — MetricsChart Recharts Migration", () => {
  it("should use Recharts components instead of SVG", () => {
    const content = readFileSync(resolve(frontendSrc, "components/MetricsChart.tsx"), "utf8");
    expect(content).toContain("recharts");
    expect(content).toContain("AreaChart");
    expect(content).toContain("ResponsiveContainer");
    expect(content).toContain("Tooltip");
    // Should NOT contain old SVG sparkline
    expect(content).not.toContain("polyline");
    expect(content).not.toContain("polygon");
  });
});

describe("Phase 3 — Themes", () => {
  it("should have ThemeContext with 3 themes", () => {
    const path = resolve(frontendSrc, "contexts/ThemeContext.tsx");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("dark");
    expect(content).toContain("light");
    expect(content).toContain("blue");
    expect(content).toContain("ThemeProvider");
    expect(content).toContain("useTheme");
    expect(content).toContain("localStorage");
  });

  it("should have themes.css with CSS variables", () => {
    const path = resolve(frontendSrc, "styles/themes.css");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain(".theme-dark");
    expect(content).toContain(".theme-light");
    expect(content).toContain(".theme-blue");
    expect(content).toContain("--nx-bg-base");
    expect(content).toContain("--nx-primary");
    expect(content).toContain("--nx-border");
  });

  it("should have theme selector in Layout", () => {
    const content = readFileSync(resolve(frontendSrc, "components/Layout.tsx"), "utf8");
    expect(content).toContain("useTheme");
    expect(content).toContain("Palette");
    expect(content).toContain("setTheme");
  });

  it("should have ThemeProvider in App", () => {
    const content = readFileSync(resolve(frontendSrc, "App.tsx"), "utf8");
    expect(content).toContain("ThemeProvider");
  });

  it("should import themes.css in main CSS", () => {
    const content = readFileSync(resolve(frontendSrc, "index.css"), "utf8");
    expect(content).toContain("themes.css");
  });
});

describe("Phase 3 — Settings Page", () => {
  it("should have Settings page with SMTP and lifecycle config", () => {
    const path = resolve(frontendSrc, "pages/Settings.tsx");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("smtp");
    expect(content).toContain("webhook");
    expect(content).toContain("health_threshold");
    expect(content).toContain("stale_after_days");
    expect(content).toContain("updateSetting");
  });

  it("should have Settings route in App", () => {
    const content = readFileSync(resolve(frontendSrc, "App.tsx"), "utf8");
    expect(content).toContain("/settings");
    expect(content).toContain("Settings");
  });

  it("should have Settings nav item in Layout", () => {
    const content = readFileSync(resolve(frontendSrc, "components/Layout.tsx"), "utf8");
    expect(content).toContain("/settings");
  });
});

describe("Phase 7 — Webhooks", () => {
  it("should have webhook service with HMAC signing", () => {
    const path = resolve(backendSrc, "services/webhook.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("sendWebhook");
    expect(content).toContain("createHmac");
    expect(content).toContain("sha256");
    expect(content).toContain("X-Nexus-Signature");
    expect(content).toContain("X-Nexus-Timestamp");
    expect(content).toContain("webhook_secret");
  });

  it("should export sendWebhook function", async () => {
    const mod = await import("../../src/services/webhook.js");
    expect(typeof mod.sendWebhook).toBe("function");
  });
});

describe("Phase 7 — Email", () => {
  it("should have email service with nodemailer", () => {
    const path = resolve(backendSrc, "services/email.ts");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("sendAlertEmail");
    expect(content).toContain("nodemailer");
    expect(content).toContain("smtp_config");
    expect(content).toContain("createTransport");
    expect(content).toContain("Nexus Alert");
  });

  it("should export sendAlertEmail function", async () => {
    const mod = await import("../../src/services/email.js");
    expect(typeof mod.sendAlertEmail).toBe("function");
  });
});

describe("Phase 7 — Alert Engine Integration", () => {
  it("should have webhook and email notifications in alert-engine", () => {
    const content = readFileSync(resolve(backendSrc, "services/alert-engine.ts"), "utf8");
    expect(content).toContain("notifyWebhook");
    expect(content).toContain("notifyEmail");
    expect(content).toContain("sendWebhook");
    expect(content).toContain("sendAlertEmail");
  });
});
