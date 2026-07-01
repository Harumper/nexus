import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const rootDir = resolve(__dirname, "../../..");
const agentDir = resolve(rootDir, "agent");
const frontendSrc = resolve(rootDir, "frontend/src");

describe("B1 — Bulk actions", () => {
  it("should have bulk.ts route with BULK_ALLOWED_ACTIONS whitelist", () => {
    const p = resolve(backendSrc, "routes/bulk.ts");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("/api/bulk/dispatch");
    expect(content).toContain("BULK_ALLOWED_ACTIONS");
    expect(content).toContain("requireAdmin");
    // Actions safe whitelisted
    expect(content).toContain("system.reboot");
    expect(content).toContain("system.update");
    expect(content).toContain("package.hold");
    // Watchdog-revert actions excluded
    expect(content).not.toMatch(/BULK_ALLOWED_ACTIONS = new Set\(\[[\s\S]*?"netplan\.apply"/);
    expect(content).not.toMatch(/BULK_ALLOWED_ACTIONS = new Set\(\[[\s\S]*?"firewall\.allow"/);
  });

  it("should enforce max 100 machines per bulk dispatch", () => {
    const content = readFileSync(resolve(backendSrc, "routes/bulk.ts"), "utf8");
    expect(content).toMatch(/targetIds\.length > 100/);
  });

  it("should register bulkRoutes in index.ts", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("bulkRoutes");
    expect(content).toContain("app.register(bulkRoutes)");
  });

  it("should have BulkActionDialog frontend component", () => {
    const p = resolve(frontendSrc, "components/BulkActionDialog.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("BULK_ACTIONS");
    expect(content).toContain("bulkDispatch");
    // Destructive confirmation
    expect(content).toContain("confirmText");
  });

  it("should have multi-select UI in Machines.tsx", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/Machines.tsx"), "utf8");
    expect(content).toContain("BulkActionDialog");
    expect(content).toContain("selected");
    // i18n: label externalized to key machines:bulkAction (FR label in the JSON).
    expect(content).toContain("bulkAction");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/machines.json"), "utf8");
    expect(fr).toContain("Action groupée");
  });
});

describe("B2 — SSL cert tracking", () => {
  it("should have ssl_scan.go with cert parsing", () => {
    const p = resolve(agentDir, "internal/actions/ssl_scan.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain('"ssl.scan"');
    expect(content).toContain("crypto/x509");
    expect(content).toContain("DaysRemaining");
    expect(content).toContain("/etc/letsencrypt/live");
    // Filter out CA and snake-oil
    expect(content).toContain("IsCA");
    expect(content).toContain("snakeoil");
  });

  it("should have sudoers for SSL cert scanning", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toMatch(/find\s+\/etc\/letsencrypt\/live/);
    expect(content).toMatch(/\/bin\/cat\s+\/etc\/letsencrypt\/live/);
  });

  it("should allow ssl.scan in PROBE_ALLOWED_ACTIONS", () => {
    const content = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(content).toContain('"ssl.scan"');
  });

  it("should have CERT_EXPIRING condition in alert-engine", () => {
    const content = readFileSync(resolve(backendSrc, "services/alert-engine.ts"), "utf8");
    expect(content).toContain("CERT_EXPIRING");
    expect(content).toContain("evaluateCertAlerts");
    expect(content).toContain("ssl.scan");
  });

  it("should surface SSL cert tracking in the frontend (useMachineAttention)", () => {
    // Cert tracking is displayed via the attention panel (MachineDetail),
    // not a dedicated SslCertsCard component (removed because never rendered).
    const p = resolve(frontendSrc, "hooks/useMachineAttention.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("sslScan");
    expect(content).toContain("days_remaining");
  });
});

describe("B4 — Extended alerting (services/timers/updates/certs)", () => {
  it("should have new AlertConditionType enum values", () => {
    const schema = readFileSync(resolve(rootDir, "backend/prisma/schema.prisma"), "utf8");
    expect(schema).toContain("SERVICE_FAILED");
    expect(schema).toContain("TIMER_FAILED");
    expect(schema).toContain("CRON_FAILED");
    expect(schema).toContain("UPDATES_AVAILABLE");
    expect(schema).toContain("CERT_EXPIRING");
  });

  it("should have migration adding new enum values + targetPattern", () => {
    const migration = resolve(
      rootDir,
      "backend/prisma/migrations/20260424160000_extend_alerting/migration.sql"
    );
    expect(existsSync(migration)).toBe(true);
    const sql = readFileSync(migration, "utf8");
    expect(sql).toContain("SERVICE_FAILED");
    expect(sql).toContain("CERT_EXPIRING");
    expect(sql).toContain("ADD COLUMN \"targetPattern\"");
  });

  it("should have health_check.go with 4 actions", () => {
    const p = resolve(agentDir, "internal/actions/health_check.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain('"system.services_failed"');
    expect(content).toContain('"system.timers_failed"');
    expect(content).toContain('"system.updates_available"');
    expect(content).toContain('"system.health_summary"');
    // Aggregation in health_summary
    expect(content).toContain("SystemHealthSummaryAction");
  });

  it("should evaluate health alerts periodically in index.ts", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("evaluateHealthAlerts");
    expect(content).toContain("5 * 60_000"); // 5 min
    expect(content).toContain("evaluateCertAlerts");
    expect(content).toContain("6 * 60 * 60_000"); // 6h
  });

  it("should support targetPattern for service/timer filtering", () => {
    const content = readFileSync(resolve(backendSrc, "services/alert-engine.ts"), "utf8");
    expect(content).toContain("targetPattern");
    expect(content).toContain("checkHealthCondition");
  });

  it("should have grouped conditions in AlertCreate.tsx UI", () => {
    // The create/edit form was moved to a dedicated page to give more room
    // to the multi-channel channels and the machine selectors. Alerts.tsx
    // only lists the rules.
    const content = readFileSync(resolve(frontendSrc, "pages/AlertCreate.tsx"), "utf8");
    expect(content).toContain("SERVICE_FAILED");
    expect(content).toContain("CERT_EXPIRING");
    expect(content).toContain("needsTargetPattern");
    expect(content).toContain("optgroup");
  });

  it("should limit concurrency in health checks", () => {
    const content = readFileSync(resolve(backendSrc, "services/alert-engine.ts"), "utf8");
    expect(content).toMatch(/concurrency = \d+/);
  });
});

describe("F1 — Package pinning (apt-mark)", () => {
  it("should have package_holds.go action", () => {
    const p = resolve(agentDir, "internal/actions/package_holds.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain('"package.holds_list"');
    expect(content).toContain('"package.hold"');
    expect(content).toContain('"package.unhold"');
    expect(content).toContain("apt-mark");
    // Package name validation
    expect(content).toContain("pkgNameRegex");
  });

  it("should have sudoers for apt-mark", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("apt-mark showhold");
    expect(content).toContain("apt-mark hold *");
    expect(content).toContain("apt-mark unhold *");
  });

  it("should show Hold column in UpdatePanel", () => {
    const content = readFileSync(resolve(frontendSrc, "components/UpdatePanel.tsx"), "utf8");
    expect(content).toContain("packageHoldsList");
    expect(content).toContain("toggleHold");
    expect(content).toContain("Hold");
  });
});
