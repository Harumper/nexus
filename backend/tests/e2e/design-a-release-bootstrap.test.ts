import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { generateInstallSteps } from "../../src/services/agent-bootstrap.js";

// Design A : le backend embarque la clé PUBLIQUE de release (NEXUS_RELEASE_PUBKEY)
// dans la commande de bootstrap → /etc/nexus/release.pub posée à l'install ET au
// reenroll. Ferme le footgun « reenroll perd release.pub » (constaté au DV-3).

const BASE = {
  machineId: "m1",
  machineName: "host1",
  enrollmentToken: "enroll_x",
  backendPublicKey: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----",
  binaryToken: "btok",
  scriptToken: "stok",
  backendUrl: "https://nexus.example.net",
};
const PUB =
  "untrusted comment: minisign public key D722D5094AB7F868\nRWRo+LdKCdUi1/4rXyYU206e9dw8+TOxBGI/YC0cIrK56hlAdjpJBIyY";

function runCmd(reenroll: boolean): string {
  const steps = generateInstallSteps({ ...BASE, reenroll });
  const run = steps.find((s) => s.id === "run");
  return run ? run.command : "";
}

describe("Design A — release.pub embarquée au bootstrap", () => {
  const prev = process.env.NEXUS_RELEASE_PUBKEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXUS_RELEASE_PUBKEY;
    else process.env.NEXUS_RELEASE_PUBKEY = prev;
  });

  it("NEXUS_RELEASE_PUBKEY absente → pas de --release-pubkey-file (inchangé)", () => {
    delete process.env.NEXUS_RELEASE_PUBKEY;
    const cmd = runCmd(false);
    expect(cmd).not.toContain("--release-pubkey-file");
    expect(cmd).not.toContain("nexus-release.pub");
    // la clé serveur reste embarquée (régression-check)
    expect(cmd).toContain("--server-public-key-file /tmp/nexus-pubkey.pem");
  });

  it("NEXUS_RELEASE_PUBKEY définie → clé écrite + --release-pubkey-file (install ET reenroll)", () => {
    process.env.NEXUS_RELEASE_PUBKEY = PUB;
    for (const reenroll of [false, true]) {
      const cmd = runCmd(reenroll);
      expect(cmd, `reenroll=${reenroll}`).toContain("tee /tmp/nexus-release.pub");
      expect(cmd, `reenroll=${reenroll}`).toContain("RWRo+LdKCdUi1/4rXyYU206e9dw8"); // la clé
      expect(cmd, `reenroll=${reenroll}`).toContain("--release-pubkey-file /tmp/nexus-release.pub");
    }
  });

  it("install-agent.sh : règle « ne pas écraser un pin existant »", () => {
    const sh = readFileSync(resolve(__dirname, "../../../scripts/install-agent.sh"), "utf8");
    expect(sh).toContain('if [ -f "$RELEASE_PUBKEY_FILE" ]; then');
    expect(sh).toContain("pin kept"); // message traduit en EN (release.pub already present — pin kept)
  });
});
