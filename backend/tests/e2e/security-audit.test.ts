import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backendSrc = resolve(__dirname, "../../src");
const agentDir = resolve(__dirname, "../../../agent");
const frontendSrc = resolve(__dirname, "../../../frontend/src");
const rootDir = resolve(__dirname, "../../..");

describe("Security Audit — Critical Fixes", () => {
  it("should have return statements in requireAuth middleware", () => {
    const content = readFileSync(resolve(backendSrc, "middleware/auth.ts"), "utf8");
    // After 401 send, there must be a return
    expect(content).toMatch(/reply\.code\(401\)\.send\([^)]*\);\s*\n\s*return/);
  });

  it("should have return statements in requireAdmin middleware", () => {
    const content = readFileSync(resolve(backendSrc, "middleware/auth.ts"), "utf8");
    // After 403 send, there must be a return
    expect(content).toMatch(/reply\.code\(403\)\.send\([^)]*\);\s*\n\s*return/);
  });

  it("should require JWT_SECRET env variable (no default)", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).toContain("JWT_SECRET");
    expect(content).not.toContain("dev-secret-change-me");
    expect(content).toContain("throw new Error");
  });

  it("should have restricted CORS origin", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).not.toMatch(/origin:\s*true/);
    expect(content).toContain("FRONTEND_URL");
  });

  it("should have CSP enabled in helmet", () => {
    const content = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(content).not.toMatch(/contentSecurityPolicy:\s*false/);
    expect(content).toContain("contentSecurityPolicy");
    expect(content).toContain("defaultSrc");
  });

  it("should have JWT expiry of 4h or less", () => {
    const content = readFileSync(resolve(backendSrc, "routes/auth.ts"), "utf8");
    expect(content).not.toContain('"24h"');
    expect(content).toContain('"4h"');
  });

  it("should have rate limit on login endpoint", () => {
    const content = readFileSync(resolve(backendSrc, "routes/auth.ts"), "utf8");
    expect(content).toContain("rateLimit");
    expect(content).toContain("max: 10");
  });

  it("should use sessionStorage instead of localStorage for tokens", () => {
    const authHook = readFileSync(resolve(frontendSrc, "hooks/useAuth.tsx"), "utf8");
    expect(authHook).not.toContain("localStorage");
    expect(authHook).toContain("sessionStorage");
  });

  it("should use sessionStorage in all components", () => {
    const files = [
      "hooks/useWebSocket.tsx",
      "pages/Alerts.tsx",
      "pages/AuditLog.tsx",
      "components/BatchUpdateDialog.tsx",
    ];
    for (const file of files) {
      const content = readFileSync(resolve(frontendSrc, file), "utf8");
      expect(content).not.toContain('localStorage.getItem("nexus_token")');
    }
  });
});

describe("Security Audit — Agent Hardening", () => {
  it("should check rand.Read error in GenerateNonce", () => {
    const content = readFileSync(resolve(agentDir, "internal/security/crypto.go"), "utf8");
    expect(content).toContain("panic");
    expect(content).toMatch(/if.*err.*:=.*rand\.Read/);
  });

  it("should document HKDF context label in DeriveSharedSecret", () => {
    const content = readFileSync(resolve(agentDir, "internal/security/crypto.go"), "utf8");
    // Backend et agent utilisent tous les deux un salt vide — doit matcher
    expect(content).toContain("nexus-shared-secret");
  });

  it("should validate timestamps on incoming action requests", () => {
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(content).toContain("IsTimestampValid");
  });

  it("should enforce PROBE whitelist cote agent", () => {
    // Le modele Capability a ete retire : le controle d'acces repose sur Machine.type.
    // L'agent doit filtrer les actions en mode probe via probeAllowedActions.
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(content).toContain("probeAllowedActions");
    expect(content).toContain("action not allowed in probe mode");
  });

  it("should use /var/lib/nexus-agent (StateDirectory) for scripts instead of /tmp", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/script_execute.go"), "utf8");
    expect(content).toContain("/var/lib/nexus-agent");
    expect(content).not.toMatch(/CreateTemp\("",/);
  });

  it("should have secure sudoers without dangerous wildcards", () => {
    const content = readFileSync(resolve(agentDir, "deploy/install.sh"), "utf8");
    // apt-get update should NOT have wildcard
    expect(content).toMatch(/apt-get update\n/);
    // NOEXEC tag on install/remove
    expect(content).toContain("NOEXEC:");
    // kill should use explicit signals
    expect(content).toContain("/bin/kill -SIGTERM");
    // Scripts in dedicated dir, not /tmp
    expect(content).toContain("/var/lib/nexus-agent/nexus-script");
    // Uses mktemp instead of hardcoded /tmp path
    expect(content).toContain("mktemp");
  });

  it("should have restricted systemd sandbox without blocking sudo/apt", () => {
    const content = readFileSync(resolve(agentDir, "deploy/nexus-agent.service"), "utf8");
    // AmbientCapabilities donnent les caps au non-root agent
    expect(content).toContain("AmbientCapabilities");
    expect(content).toContain("CAP_NET_RAW");
    // Pas de CapabilityBoundingSet : bloquerait sudo+apt (chown, fowner, etc.)
    expect(content).not.toContain("CapabilityBoundingSet=");
    // Sandbox reste actif via les autres directives
    expect(content).toContain("ProtectHome=true");
    expect(content).toContain("ProtectKernelModules=true");
    expect(content).toContain("LockPersonality=true");
  });
});

describe("Security Audit — Docker & Infrastructure", () => {
  it("should require secrets in docker-compose (no weak defaults)", () => {
    const content = readFileSync(resolve(rootDir, "docker-compose.yml"), "utf8");
    expect(content).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?");
    expect(content).toContain("JWT_SECRET: ${JWT_SECRET:?");
    expect(content).toContain("ECDSA_MASTER_SECRET: ${ECDSA_MASTER_SECRET:?");
    expect(content).not.toContain("dev_jwt_secret");
  });

  it("should have healthchecks for backend and frontend", () => {
    const content = readFileSync(resolve(rootDir, "docker-compose.yml"), "utf8");
    // Count healthcheck occurrences (postgres + backend + frontend = 3)
    const matches = content.match(/healthcheck:/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it("should have CSP header in nginx configs", () => {
    const httpConf = readFileSync(resolve(rootDir, "frontend/nginx-http.conf"), "utf8");
    const httpsConf = readFileSync(resolve(rootDir, "frontend/nginx-https.conf"), "utf8");
    expect(httpConf).toContain("Content-Security-Policy");
    expect(httpsConf).toContain("Content-Security-Policy");
  });

  it("should have .dockerignore files", () => {
    expect(existsSync(resolve(rootDir, "backend/.dockerignore"))).toBe(true);
    expect(existsSync(resolve(rootDir, "frontend/.dockerignore"))).toBe(true);
    expect(existsSync(resolve(rootDir, "agent/.dockerignore"))).toBe(true);
  });

  it("should use docker login --password-stdin in CI", () => {
    const content = readFileSync(resolve(rootDir, ".gitlab-ci.yml"), "utf8");
    expect(content).toContain("--password-stdin");
    expect(content).not.toMatch(/docker login -u.*-p\s/);
  });
});
