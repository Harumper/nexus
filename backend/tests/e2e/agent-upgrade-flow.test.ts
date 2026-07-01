import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const rootDir = resolve(__dirname, "../../..");
const agentDir = resolve(rootDir, "agent");
const frontendSrc = resolve(rootDir, "frontend/src");

describe("Agent self-upgrade — version-aware flow with tracking", () => {
  it("agent emits upgrade progress and reports its SHA", () => {
    const upgrade = readFileSync(
      resolve(agentDir, "internal/actions/agent_upgrade.go"),
      "utf8"
    );
    // Dedicated progress callback (distinct from apt system updates)
    expect(upgrade).toContain("OnAgentUpgradeProgress");
    expect(upgrade).toContain("upgradeProgress(");

    const main = readFileSync(
      resolve(agentDir, "cmd/nexus-agent/main.go"),
      "utf8"
    );
    // SHA of the current binary added to the heartbeat
    expect(main).toContain("agent_sha256");
    expect(main).toContain("func selfSHA256()");
    // Wiring of the progress callback
    expect(main).toContain("actions.OnAgentUpgradeProgress");

    const messages = readFileSync(
      resolve(agentDir, "internal/transport/messages.go"),
      "utf8"
    );
    expect(messages).toContain('TypeAgentUpgradeProgress = "agent.upgrade.progress"');
  });

  it("backend has an in-memory tracker with timeout and broadcast result", () => {
    const p = resolve(backendSrc, "services/agent-upgrade-tracker.ts");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("beginUpgrade");
    expect(content).toContain("onAgentHeartbeat");
    expect(content).toContain("getServerBinarySHA256");
    expect(content).toContain("getLatestAgentSha");
    // Success = reconnect with the target SHA; failure = timeout
    expect(content).toContain("agent.upgrade.result");
    expect(content).toMatch(/reason:\s*"timeout"/);
  });

  it("the heartbeat feeds the tracker and progress is relayed", () => {
    const handler = readFileSync(
      resolve(backendSrc, "websocket/handler.ts"),
      "utf8"
    );
    expect(handler).toContain("onAgentHeartbeat");
    expect(handler).toContain("AGENT_UPGRADE_PROGRESS");

    const protocol = readFileSync(
      resolve(backendSrc, "websocket/protocol.ts"),
      "utf8"
    );
    expect(protocol).toContain('AGENT_UPGRADE_PROGRESS: "agent.upgrade.progress"');
  });

  it("agent-status endpoint exposes the SHA comparison (update available)", () => {
    const content = readFileSync(resolve(backendSrc, "routes/machines.ts"), "utf8");
    expect(content).toContain("/api/machines/:id/agent-status");
    expect(content).toContain("updateAvailable");
    expect(content).toContain("targetSha");
  });

  it("frontend has the tracking modal with debug/SSH panel", () => {
    const p = resolve(frontendSrc, "components/AgentUpgradeDialog.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    // State machine + WS event listening
    expect(content).toContain("agent.upgrade.progress");
    expect(content).toContain("agent.upgrade.result");
    // Modal persistent during the work (closing blocked)
    expect(content).toContain("guardedClose");
    // Collapsible debug panel: SSH + diagnostic commands
    // i18n: title externalized to key agentUpgrade:debug.title (FR in the JSON).
    expect(content).toContain("debug.title");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/agentUpgrade.json"), "utf8");
    expect(fr).toContain("Debug & accès SSH");
    expect(content).toContain("journalctl -u nexus-agent");
    expect(content).toContain("systemctl restart nexus-agent");
  });

  it("MachineDetail opens the modal and shows the update-available badge", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/MachineDetail.tsx"), "utf8");
    expect(content).toContain("AgentUpgradeDialog");
    expect(content).toContain("agentUpdateAvailable");
    expect(content).toContain("MAJ dispo");
  });

  it("the agent SHA is persisted (schema + heartbeat) for the fleet-wide badge", () => {
    const schema = readFileSync(
      resolve(rootDir, "backend/prisma/schema.prisma"),
      "utf8"
    );
    expect(schema).toMatch(/agentSha256\s+String\?/);
    // Migration present
    const migDir = resolve(rootDir, "backend/prisma/migrations");
    const migs = require("fs").readdirSync(migDir) as string[];
    const hasMig = migs.some((d) =>
      existsSync(resolve(migDir, d, "migration.sql")) &&
      readFileSync(resolve(migDir, d, "migration.sql"), "utf8").includes(
        'ADD COLUMN "agentSha256"'
      )
    );
    expect(hasMig).toBe(true);
    // Persistence at heartbeat
    const mm = readFileSync(
      resolve(backendSrc, "services/machine-manager.ts"),
      "utf8"
    );
    expect(mm).toContain("agentSha256: data.agent_sha256");
  });

  it("the list route computes agentUpdateAvailable (fleet badge)", () => {
    const content = readFileSync(resolve(backendSrc, "routes/machines.ts"), "utf8");
    expect(content).toContain("agentUpdateAvailable");
    // Comparison against the served target SHA
    expect(content).toContain("getServerBinarySHA256");
  });

  it("MachineCard shows the agent badge in the fleet", () => {
    const content = readFileSync(resolve(frontendSrc, "components/MachineCard.tsx"), "utf8");
    expect(content).toContain("agentUpdateAvailable");
  });
});
