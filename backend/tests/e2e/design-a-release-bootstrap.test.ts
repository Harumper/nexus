import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { generateInstallSteps } from "../../src/services/agent-bootstrap.js";

// Design A: the backend embeds the release PUBLIC key (NEXUS_RELEASE_PUBKEY)
// in the bootstrap command → /etc/nexus/release.pub laid down at install AND at
// reenroll. Closes the "reenroll loses release.pub" footgun (seen at DV-3).

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

describe("Design A — release.pub embedded at bootstrap", () => {
  const prev = process.env.NEXUS_RELEASE_PUBKEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXUS_RELEASE_PUBKEY;
    else process.env.NEXUS_RELEASE_PUBKEY = prev;
  });

  it("NEXUS_RELEASE_PUBKEY absent → no --release-pubkey-file (unchanged)", () => {
    delete process.env.NEXUS_RELEASE_PUBKEY;
    const cmd = runCmd(false);
    expect(cmd).not.toContain("--release-pubkey-file");
    expect(cmd).not.toContain("nexus-release.pub");
    // the server key stays embedded (regression-check)
    expect(cmd).toContain("--server-public-key-file /tmp/nexus-pubkey.pem");
  });

  it("NEXUS_RELEASE_PUBKEY set → key written + --release-pubkey-file (install AND reenroll)", () => {
    process.env.NEXUS_RELEASE_PUBKEY = PUB;
    for (const reenroll of [false, true]) {
      const cmd = runCmd(reenroll);
      expect(cmd, `reenroll=${reenroll}`).toContain("tee /tmp/nexus-release.pub");
      expect(cmd, `reenroll=${reenroll}`).toContain("RWRo+LdKCdUi1/4rXyYU206e9dw8"); // the key
      expect(cmd, `reenroll=${reenroll}`).toContain("--release-pubkey-file /tmp/nexus-release.pub");
    }
  });

  it("install-agent.sh: rule \"do not overwrite an existing pin\"", () => {
    const sh = readFileSync(resolve(__dirname, "../../../scripts/install-agent.sh"), "utf8");
    expect(sh).toContain('if [ -f "$RELEASE_PUBKEY_FILE" ]; then');
    expect(sh).toContain("pin kept"); // message traduit en EN (release.pub already present — pin kept)
  });
});
