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
    // i18n : titre externalisé en clé agentUpgrade:debug.title (FR dans le JSON).
    expect(content).toContain("debug.title");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/agentUpgrade.json"), "utf8");
    expect(fr).toContain("Debug & accès SSH");
    expect(content).toContain("journalctl -u nexus-agent");
    expect(content).toContain("systemctl restart nexus-agent");
  });

  it("MachineDetail ouvre la modal et affiche le badge MAJ dispo", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/MachineDetail.tsx"), "utf8");
    expect(content).toContain("AgentUpgradeDialog");
    expect(content).toContain("agentUpdateAvailable");
    expect(content).toContain("MAJ dispo");
  });

  it("le SHA agent est persisté (schema + heartbeat) pour le badge flotte-wide", () => {
    const schema = readFileSync(
      resolve(rootDir, "backend/prisma/schema.prisma"),
      "utf8"
    );
    expect(schema).toMatch(/agentSha256\s+String\?/);
    // Migration présente
    const migDir = resolve(rootDir, "backend/prisma/migrations");
    const migs = require("fs").readdirSync(migDir) as string[];
    const hasMig = migs.some((d) =>
      existsSync(resolve(migDir, d, "migration.sql")) &&
      readFileSync(resolve(migDir, d, "migration.sql"), "utf8").includes(
        'ADD COLUMN "agentSha256"'
      )
    );
    expect(hasMig).toBe(true);
    // Persistance au heartbeat
    const mm = readFileSync(
      resolve(backendSrc, "services/machine-manager.ts"),
      "utf8"
    );
    expect(mm).toContain("agentSha256: data.agent_sha256");
  });

  it("la route liste calcule agentUpdateAvailable (badge flotte)", () => {
    const content = readFileSync(resolve(backendSrc, "routes/machines.ts"), "utf8");
    expect(content).toContain("agentUpdateAvailable");
    // Comparaison au SHA cible servi
    expect(content).toContain("getServerBinarySHA256");
  });

  it("MachineCard affiche le badge agent dans la flotte", () => {
    const content = readFileSync(resolve(frontendSrc, "components/MachineCard.tsx"), "utf8");
    expect(content).toContain("agentUpdateAvailable");
  });
});
