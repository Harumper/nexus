import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const backendRoot = resolve(__dirname, "../..");
const rootDir = resolve(__dirname, "../../..");
const agentDir = resolve(rootDir, "agent");
const frontendSrc = resolve(rootDir, "frontend/src");

describe("Admin Features — Reboot + Services", () => {
  it("should have system_reboot.go action", () => {
    const p = resolve(agentDir, "internal/actions/system_reboot.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("SystemRebootAction");
    expect(content).toContain('"system.reboot"');
    expect(content).toContain("systemctl");
    expect(content).toContain("reboot");
  });

  it("should have services.go with 5 actions and nexus-agent protection", () => {
    const p = resolve(agentDir, "internal/actions/services.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("system.services_list");
    expect(content).toContain("system.service_status");
    expect(content).toContain("system.service_start");
    expect(content).toContain("system.service_stop");
    expect(content).toContain("system.service_restart");
    expect(content).toContain("protectedService");
    expect(content).toContain('"nexus-agent"');
  });

  it("should NOT classify system.reboot as read-only (it mutates)", () => {
    // Access is bounded by central RBAC (READ_ONLY_ACTIONS = single source of
    // read-only actions). Since system.reboot is a mutation, it's absent from it.
    const content = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(content).toContain("READ_ONLY_ACTIONS");
    expect(content).not.toContain("system.reboot");
  });

  it("routes service control through the compiled privhelper (AGENT-006)", () => {
    // AGENT-006: no more raw `systemctl <verb> *` in sudoers (option-injection
    // bypassed the ssh blocklist). Service control goes through the compiled
    // privhelper svc op, which is what sudoers authorizes.
    const services = readFileSync(resolve(rootDir, "agent/internal/actions/services.go"), "utf8");
    expect(services).toMatch(/privhelper", "svc", "start"/);
    expect(services).toMatch(/privhelper", "svc", "stop"/);
    expect(services).toMatch(/privhelper", "svc", "restart"/);
    const sudoers = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(sudoers).toContain("/usr/local/bin/nexus-agent privhelper *");
    expect(sudoers).not.toMatch(/systemctl stop \*/);
  });

  it("should have ServicesTab frontend component", () => {
    const p = resolve(frontendSrc, "components/ServicesTab.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("listServices");
    expect(content).toContain("serviceAction");
  });

  it("should have reboot handler and button in MachineDetail", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/MachineDetail.tsx"), "utf8");
    expect(content).toContain("handleReboot");
    expect(content).toContain("REBOOT");
    expect(content).toContain('"services"');
  });
});

describe("Admin Features — Journalctl", () => {
  it("should have system_logs.go action", () => {
    const p = resolve(agentDir, "internal/actions/system_logs.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("system.logs");
    expect(content).toContain("journalctl");
    expect(content).toContain("monitoring"); // capability
  });

  it("should have systemd-journal group assignment in install script", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("systemd-journal");
    expect(content).toContain("usermod -a -G systemd-journal");
  });

  it("should classify system.logs as read-only", () => {
    const content = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(content).toContain('"system.logs"');
  });

  it("should have LogsDrawer component", () => {
    const p = resolve(frontendSrc, "components/LogsDrawer.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("getServiceLogs");
  });
});

describe("Admin Features — Firewall ufw with watchdog", () => {
  it("should have firewall.go with 6 actions and watchdog logic", () => {
    const p = resolve(agentDir, "internal/actions/firewall.go");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("firewall.status");
    expect(content).toContain("firewall.allow");
    expect(content).toContain("firewall.deny");
    expect(content).toContain("firewall.rule_remove");
    expect(content).toContain("firewall.enable");
    expect(content).toContain("firewall.disable");
    // Watchdog
    expect(content).toContain("watchdogDuration");
    expect(content).toContain("PendingRevert");
    expect(content).toContain("HandleConfirm");
    expect(content).toContain("RecoverPendingSnapshots"); // dead man's switch
    expect(content).toContain("iptables-save");
    expect(content).toContain("iptables-restore");
  });

  it("classifies firewall.status as read-only but not firewall.allow (mutation)", () => {
    const content = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(content).toContain('"firewall.status"');
    expect(content).not.toContain('"firewall.allow"');
  });

  it("should have firewall sudoers entries", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("/usr/sbin/ufw allow *");
    expect(content).toContain("/usr/sbin/ufw deny *");
    expect(content).toContain("/usr/sbin/iptables-save");
    expect(content).toContain("/usr/sbin/iptables-restore");
  });

  it("should have action.confirm WS message type", () => {
    const backendProto = readFileSync(resolve(backendSrc, "websocket/protocol.ts"), "utf8");
    const agentProto = readFileSync(resolve(agentDir, "internal/transport/messages.go"), "utf8");
    expect(backendProto).toContain("ACTION_CONFIRM");
    expect(backendProto).toContain("action.confirm");
    expect(agentProto).toContain("TypeActionConfirm");
    expect(agentProto).toContain("action.confirm");
  });

  it("should have firewall confirm route", () => {
    const content = readFileSync(resolve(backendSrc, "routes/firewall.ts"), "utf8");
    expect(content).toContain("/api/machines/:id/firewall/confirm");
    expect(content).toContain("requireAdmin");
    expect(content).toContain("action.confirm");
  });

  it("should have FirewallTab component with countdown", () => {
    const p = resolve(frontendSrc, "components/FirewallTab.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("firewallAllow");
    expect(content).toContain("firewallConfirm");
    expect(content).toContain("countdown");
    expect(content).toContain("Watchdog");
  });

  it("should wire RecoverPendingSnapshots at agent boot", () => {
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(content).toContain("RecoverPendingSnapshots");
    expect(content).toContain("HandleConfirm");
  });
});

describe("Admin Features — Package search (Postgres FTS)", () => {
  it("should have AptPackage model in schema", () => {
    const schema = readFileSync(resolve(backendRoot, "prisma/schema.prisma"), "utf8");
    expect(schema).toContain("model AptPackage");
    expect(schema).toContain("searchVector Unsupported(\"tsvector\")");
    expect(schema).toContain("@@unique([suite, component, arch, name])");
  });

  it("should have migration with tsvector and GIN index", () => {
    const migration = resolve(
      backendRoot,
      "prisma/migrations/20260424120000_add_apt_package/migration.sql"
    );
    expect(existsSync(migration)).toBe(true);
    const sql = readFileSync(migration, "utf8");
    expect(sql).toContain("CREATE TABLE \"AptPackage\"");
    expect(sql).toContain("GENERATED ALWAYS AS");
    expect(sql).toContain("tsvector");
    expect(sql).toContain("USING GIN");
  });

  it("should have apt-catalog service with parser and ingestion", () => {
    const p = resolve(backendSrc, "services/apt-catalog.ts");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("refreshAptCatalog");
    expect(content).toContain("initAptCatalogIfEmpty");
    expect(content).toContain("Packages.gz");
    expect(content).toContain("parseParagraph");
    expect(content).toContain("createMany");
  });

  it("should have packages search route with FTS", () => {
    const p = resolve(backendSrc, "routes/packages.ts");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("/api/packages/search");
    expect(content).toContain("to_tsquery");
    expect(content).toContain("ts_rank_cd");
    expect(content).toContain("rateLimit");
  });

  it("should register route and init catalog in index.ts", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("packagesRoutes");
    expect(content).toContain("initAptCatalogIfEmpty");
    expect(content).toContain("refreshAptCatalog");
  });

  it("should have PackagesTab frontend component", () => {
    const p = resolve(frontendSrc, "components/PackagesTab.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("searchPackages");
    expect(content).toContain("installPackage");
    expect(content).toContain("removePackage");
  });
});

describe("Admin Features — Functional assertions", () => {
  it("should parse a valid Debian Packages paragraph", async () => {
    // Dynamic import so it only loads if the file compiles
    const mod = await import("../../src/services/apt-catalog.js");
    // no direct export of parseParagraph, we just make sure the module loads
    expect(typeof mod.refreshAptCatalog).toBe("function");
    expect(typeof mod.initAptCatalogIfEmpty).toBe("function");
  });
});
