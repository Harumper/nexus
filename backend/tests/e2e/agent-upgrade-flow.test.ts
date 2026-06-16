import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const rootDir = resolve(__dirname, "../../..");
const agentDir = resolve(rootDir, "agent");
const frontendSrc = resolve(rootDir, "frontend/src");

describe("Agent self-upgrade — flow version-aware avec suivi", () => {
  it("agent émet la progression d'upgrade et rapporte son SHA", () => {
    const upgrade = readFileSync(
      resolve(agentDir, "internal/actions/agent_upgrade.go"),
      "utf8"
    );
    // Callback de progression dédié (distinct des MAJ système apt)
    expect(upgrade).toContain("OnAgentUpgradeProgress");
    expect(upgrade).toContain("upgradeProgress(");

    const main = readFileSync(
      resolve(agentDir, "cmd/nexus-agent/main.go"),
      "utf8"
    );
    // SHA du binaire courant ajouté au heartbeat
    expect(main).toContain("agent_sha256");
    expect(main).toContain("func selfSHA256()");
    // Wiring du callback de progression
    expect(main).toContain("actions.OnAgentUpgradeProgress");

    const messages = readFileSync(
      resolve(agentDir, "internal/transport/messages.go"),
      "utf8"
    );
    expect(messages).toContain('TypeAgentUpgradeProgress = "agent.upgrade.progress"');
  });

  it("backend a un tracker en mémoire avec timeout et résultat broadcasté", () => {
    const p = resolve(backendSrc, "services/agent-upgrade-tracker.ts");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("beginUpgrade");
    expect(content).toContain("onAgentHeartbeat");
    expect(content).toContain("getServerBinarySHA256");
    expect(content).toContain("getLatestAgentSha");
    // Succès = reconnexion avec le SHA cible ; échec = timeout
    expect(content).toContain("agent.upgrade.result");
    expect(content).toMatch(/reason:\s*"timeout"/);
  });

  it("le heartbeat alimente le tracker et la progression est relayée", () => {
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

  it("endpoint agent-status expose la comparaison de SHA (MAJ dispo)", () => {
    const content = readFileSync(resolve(backendSrc, "routes/machines.ts"), "utf8");
    expect(content).toContain("/api/machines/:id/agent-status");
    expect(content).toContain("updateAvailable");
    expect(content).toContain("targetSha");
  });

  it("frontend a la modal de suivi avec panneau debug/SSH", () => {
    const p = resolve(frontendSrc, "components/AgentUpgradeDialog.tsx");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    // Machine à états + écoute des événements WS
    expect(content).toContain("agent.upgrade.progress");
    expect(content).toContain("agent.upgrade.result");
    // Modal persistant pendant le travail (fermeture bloquée)
    expect(content).toContain("guardedClose");
    // Panneau debug repliable : SSH + commandes de diagnostic
    expect(content).toContain("Debug & accès SSH");
    expect(content).toContain("journalctl -u nexus-agent");
    expect(content).toContain("systemctl restart nexus-agent");
  });

  it("MachineDetail ouvre la modal et affiche le badge MAJ dispo", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/MachineDetail.tsx"), "utf8");
    expect(content).toContain("AgentUpgradeDialog");
    expect(content).toContain("agentUpdateAvailable");
    expect(content).toContain("MAJ dispo");
  });
});
