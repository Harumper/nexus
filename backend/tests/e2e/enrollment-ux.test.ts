import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const backendRoot = resolve(__dirname, "../..");
const rootDir = resolve(__dirname, "../../..");
const frontendSrc = resolve(rootDir, "frontend/src");

describe("Enrollment UX v2 — Schema & Services", () => {
  it("should have BootstrapToken model in schema", () => {
    const schema = readFileSync(resolve(backendRoot, "prisma/schema.prisma"), "utf8");
    expect(schema).toContain("model BootstrapToken");
    expect(schema).toContain("tokenHash String    @unique");
    expect(schema).toContain("purpose   String");
    expect(schema).toContain("expiresAt DateTime");
    expect(schema).toContain("usedAt    DateTime?");
    expect(schema).toContain("@@index([machineId, purpose])");
    expect(schema).toContain("@@index([expiresAt])");
  });

  it("should have Machine.bootstrapTokens relation", () => {
    const schema = readFileSync(resolve(backendRoot, "prisma/schema.prisma"), "utf8");
    expect(schema).toContain("bootstrapTokens   BootstrapToken[]");
  });

  it("should have migration file for BootstrapToken", () => {
    const migration = resolve(
      backendRoot,
      "prisma/migrations/20260423193000_add_bootstrap_tokens/migration.sql"
    );
    expect(existsSync(migration)).toBe(true);
    const sql = readFileSync(migration, "utf8");
    expect(sql).toContain("CREATE TABLE \"BootstrapToken\"");
    expect(sql).toContain("CREATE UNIQUE INDEX \"BootstrapToken_tokenHash_key\"");
  });

  it("should have bootstrap service with single-use atomic validation", () => {
    const content = readFileSync(resolve(backendSrc, "services/bootstrap.ts"), "utf8");
    expect(content).toContain("generateBootstrapToken");
    expect(content).toContain("validateBootstrapToken");
    expect(content).toContain("invalidateInstallTokens");
    expect(content).toContain("cleanupExpiredTokens");
    expect(content).toContain("sha256"); // hash
    expect(content).toContain("base64url"); // random token format
    expect(content).toContain("updateMany"); // atomic claim pattern
  });

  it("should have agent-bootstrap service with install steps generator", () => {
    const content = readFileSync(resolve(backendSrc, "services/agent-bootstrap.ts"), "utf8");
    expect(content).toContain("generateInstallSteps");
    expect(content).toContain("stepsToSingleCommand");
    expect(content).toContain("getAgentBackendUrl");
    expect(content).toContain("/api/agents/download");
    expect(content).toContain("/api/agents/install-script");
    expect(content).toContain("--server-public-key-file");
  });
});

describe("Enrollment UX v2 — Routes", () => {
  it("should have agent-download route with rate limit", () => {
    const content = readFileSync(resolve(backendSrc, "routes/agent-download.ts"), "utf8");
    expect(content).toContain("/api/agents/download");
    expect(content).toContain("/api/agents/install-script");
    expect(content).toContain("rateLimit");
    expect(content).toContain("validateBootstrapToken");
  });

  it("should register agent-download route in index", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("agentDownloadRoutes");
    expect(content).toContain("cleanupExpiredTokens");
  });

  it("should extend POST /machines with bootstrap artifacts", () => {
    const content = readFileSync(resolve(backendSrc, "routes/machines.ts"), "utf8");
    expect(content).toContain("buildBootstrapArtifacts");
    expect(content).toContain("bootstrap/regenerate");
    expect(content).toContain("invalidateInstallTokens");
  });
});

describe("Enrollment UX v2 — Docker & Scripts", () => {
  it("should NOT compile the agent in the backend image (mechanism A: binary served from /release volume)", () => {
    // Invariant "signé == servi" : un SEUL build produit le binaire servi (job CI
    // release-build), donc l'image backend ne compile/embarque plus l'agent.
    const dockerfile = readFileSync(resolve(backendRoot, "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("agent-builder");
    expect(dockerfile).not.toContain("/app/agent/nexus-agent");
    expect(dockerfile).toContain("COPY scripts/install-agent.sh /app/scripts/install-agent.sh");

    // Binaire + signature minisign + version servis depuis le volume /release.
    const compose = readFileSync(resolve(rootDir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("/release:ro");
    expect(compose).toContain("NEXUS_AGENT_BINARY_PATH: /release/nexus-agent");
    expect(compose).toContain("NEXUS_AGENT_SIGNATURE_PATH: /release/nexus-agent.minisig");
    expect(compose).toContain("NEXUS_AGENT_VERSION_PATH: /release/VERSION");
  });

  it("should have install-agent.sh with --server-public-key-file flag", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("--server-public-key-file");
    expect(content).toContain('SERVER_PUBLIC_KEY="$(cat "$2")"');
  });

  it("should refuse a token on a host that already has a local identity (anti-deadlock guard, never auto-purges)", () => {
    // Feature B : un --enrollment-token fourni alors qu'une identité locale existe
    // (shared.secret) ferait ignorer le token par l'agent → boucle handshake error.
    // On REFUSE (exit), on ne purge JAMAIS automatiquement : la purge exige --reenroll.
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    const guard = 'if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -n "$ENROLLMENT_TOKEN" ]; then';
    expect(content).toContain(guard);
    // Le bloc de garde mène à un refus (exit 1) et oriente vers les deux issues.
    const block = content.slice(content.indexOf(guard));
    const body = block.slice(0, block.indexOf("\nfi\n"));
    expect(body).toContain("exit 1");
    expect(body).toContain("--reenroll");
    expect(body).toMatch(/WITHOUT --enrollment-token/);
    // Refus pur : le garde-fou ne déclenche aucune purge (pas de table rase ici).
    expect(body).not.toContain("wipe_agent");
    // La détection d'identité doit cibler le marqueur d'enrôlement v2 "enrolled" (ce que
    // l'agent teste via IsEnrolled), PAS shared.secret : vestige v1 jamais écrit en v2 →
    // la détection serait toujours false et le garde-fou inopérant (régression vécue).
    const detectLine = content
      .split("\n")
      .find((l) => l.includes('"$KEY_DIR/enrolled"') && l.includes("MODE"));
    expect(detectLine, "HAS_LOCAL_IDENTITY doit tester $KEY_DIR/enrolled").toBeTruthy();
    expect(detectLine).not.toContain("shared.secret");
  });

  it("should have docker-compose with repo-root context and AGENT_BACKEND_URL", () => {
    const content = readFileSync(resolve(rootDir, "docker-compose.yml"), "utf8");
    expect(content).toContain("context: .");
    expect(content).toContain("dockerfile: backend/Dockerfile");
    expect(content).toContain("AGENT_BACKEND_URL");
  });
});

describe("Enrollment UX v2 — Frontend", () => {
  it("should have MachineEnroll page with 3-step wizard", () => {
    const path = resolve(frontendSrc, "pages/MachineEnroll.tsx");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("StepIndicator");
    expect(content).toContain("installSteps");
    expect(content).toContain("regenerateBootstrap");
    expect(content).toContain("Polling"); // text mention or timer comment
    // i18n : libellé externalisé en clé enroll:status.handshake (FR dans le JSON).
    expect(content).toContain("status.handshake");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/enroll.json"), "utf8");
    expect(fr).toContain("Handshake ECDSA");
  });

  it("should have routes for /machines/new and /machines/:id/enroll", () => {
    const content = readFileSync(resolve(frontendSrc, "App.tsx"), "utf8");
    expect(content).toContain('path="/machines/new"');
    expect(content).toContain('path="/machines/:id/enroll"');
    expect(content).toContain("MachineEnroll");
  });

  it("should have regenerateBootstrap in api client", () => {
    const content = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(content).toContain("regenerateBootstrap");
    expect(content).toContain("bootstrap/regenerate");
  });

  it("should have BootstrapArtifacts types", () => {
    const content = readFileSync(resolve(frontendSrc, "types/index.ts"), "utf8");
    expect(content).toContain("interface InstallStep");
    expect(content).toContain("interface BootstrapArtifacts");
    expect(content).toContain("interface CreateMachineResponse");
    expect(content).toContain("bootstrap: BootstrapArtifacts | null");
  });

  it("should have removed AddMachineDialog component", () => {
    const path = resolve(frontendSrc, "components/AddMachineDialog.tsx");
    expect(existsSync(path)).toBe(false);
  });

  it("should have Régénérer action in MachineCard for pending machines", () => {
    const content = readFileSync(resolve(frontendSrc, "components/MachineCard.tsx"), "utf8");
    expect(content).toContain("isPending");
    // i18n : l'action est externalisée en clé card.regenerateInstall ; le label
    // FR "Régénérer l'installation" vit dans le fichier de langue.
    expect(content).toContain("regenerateInstall");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/machines.json"), "utf8");
    expect(fr).toContain("Régénérer");
    expect(content).toContain("/enroll");
  });

  it("should navigate from Machines page instead of opening dialog", () => {
    const content = readFileSync(resolve(frontendSrc, "pages/Machines.tsx"), "utf8");
    expect(content).not.toContain("AddMachineDialog");
    expect(content).toContain('navigate("/machines/new")');
  });
});

describe("Enrollment UX v2 — Functional assertions", () => {
  it("should generate 3 install steps with correct content", async () => {
    const mod = await import("../../src/services/agent-bootstrap.js");
    const steps = mod.generateInstallSteps({
      machineId: "mid-test",
      machineName: "test",
      enrollmentToken: "enr-test",
      backendPublicKey: "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----",
      binaryToken: "bin-tok",
      scriptToken: "scr-tok",
      backendUrl: "https://nexus.example.com",
    });
    expect(steps).toHaveLength(3);
    expect(steps[0].id).toBe("binary");
    expect(steps[0].command).toContain("bin-tok");
    expect(steps[0].command).toContain("/api/agents/download");
    expect(steps[1].id).toBe("script");
    expect(steps[1].command).toContain("scr-tok");
    expect(steps[1].command).toContain("/api/agents/install-script");
    expect(steps[2].id).toBe("run");
    expect(steps[2].command).toContain("mid-test");
    expect(steps[2].command).toContain("enr-test");
    expect(steps[2].command).toContain("--server-public-key-file");
    expect(steps[2].command).toContain("wss://nexus.example.com/ws/agent");
  });

  it("should derive ws:// from http:// backend URL", async () => {
    const mod = await import("../../src/services/agent-bootstrap.js");
    expect(mod.getWsAgentUrl("http://localhost:26031")).toBe("ws://localhost:26031/ws/agent");
    expect(mod.getWsAgentUrl("https://nexus.example.com")).toBe("wss://nexus.example.com/ws/agent");
  });

  it("should throw if AGENT_BACKEND_URL is not set", async () => {
    const mod = await import("../../src/services/agent-bootstrap.js");
    const orig = process.env.AGENT_BACKEND_URL;
    delete process.env.AGENT_BACKEND_URL;
    try {
      expect(() => mod.getAgentBackendUrl()).toThrow(/AGENT_BACKEND_URL/);
    } finally {
      if (orig !== undefined) process.env.AGENT_BACKEND_URL = orig;
    }
  });

  it("should join steps with numbered comments in stepsToSingleCommand", async () => {
    const mod = await import("../../src/services/agent-bootstrap.js");
    const out = mod.stepsToSingleCommand([
      { id: "a", title: "First", description: "d", command: "echo 1" },
      { id: "b", title: "Second", description: "d", command: "echo 2" },
    ]);
    expect(out).toContain("# Étape 1/2 — First");
    expect(out).toContain("# Étape 2/2 — Second");
    expect(out).toContain("echo 1");
    expect(out).toContain("echo 2");
  });
});
