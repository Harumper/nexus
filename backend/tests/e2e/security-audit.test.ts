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

  it("should fully verify incoming action.request (signature + nonce + timestamp)", () => {
    // action.request dispatche TOUTES les actions mutantes (script.execute,
    // package.install, user.create, firewall...). Il doit etre verifie comme
    // action.confirm : VerifyServerMessage controle la signature ECDSA du
    // backend + le nonce (anti-replay) + le timestamp. Un simple controle de
    // timestamp ne suffit pas (trame chiffree rejouable dans la fenetre).
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    const actionReqIdx = content.indexOf("case transport.TypeActionRequest:");
    const actionConfIdx = content.indexOf("case transport.TypeActionConfirm:");
    expect(actionReqIdx).toBeGreaterThan(-1);
    // Le bloc action.request doit appeler VerifyServerMessage avant de dispatcher.
    const actionReqBlock = content.slice(actionReqIdx, actionConfIdx);
    expect(actionReqBlock).toContain("VerifyServerMessage");
    expect(actionReqBlock).toContain("serverPublicKey");
  });

  it("should enforce per-action RBAC centrally in dispatchAction", () => {
    // C1 : sans RBAC par action, tout utilisateur authentifie (READONLY/OPERATOR)
    // pouvait dispatcher script.execute = RCE root. Le controle doit etre dans
    // dispatchAction (couvre sync/async/bulk/batch), pas seulement au niveau route.
    const dispatcher = readFileSync(resolve(backendSrc, "services/action-dispatcher.ts"), "utf8");
    expect(dispatcher).toContain("checkRoleForAction");

    const priv = readFileSync(resolve(backendSrc, "services/privileged-actions.ts"), "utf8");
    expect(priv).toContain("checkRoleForAction");
    // script.execute doit etre reserve ADMIN.
    expect(priv).toContain("ADMIN_ONLY_ACTIONS");
    expect(priv).toMatch(/ADMIN_ONLY_ACTIONS[\s\S]*script\.execute/);
    // READONLY borne a la liste lecture seule (source unique : PROBE_ALLOWED_ACTIONS).
    expect(priv).toContain("READ_ONLY_ACTIONS");
    expect(priv).toContain("PROBE_ALLOWED_ACTIONS");
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
    // Script réellement servi aux agents (pas l'ancien agent/deploy/install.sh).
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
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
    // upgrade/update must use EXACT args (no trailing wildcard → pas d'injection -o)
    expect(content).not.toMatch(/apt-get upgrade -y \*/);
    expect(content).toContain("/usr/bin/apt-get upgrade -y -q");
    // Les clés privées TLS ne doivent JAMAIS être lisibles via sudo cat
    expect(content).not.toContain("/etc/ssl/private/");
    expect(content).not.toMatch(/cat \/etc\/letsencrypt\/live\/\*\/\*\.pem/);
    expect(content).not.toMatch(/cat \/etc\/nginx\/ssl\/\*$/m);
  });

  it("should enforce mandatory server key pinning in the agent", () => {
    const mainGo = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    // Boot fatal si pas de clé serveur (plus de simple WARNING)
    expect(mainGo).toMatch(/ServerPublicKey == ""/);
    expect(mainGo).toContain("log.Fatal");
    const enroll = readFileSync(resolve(agentDir, "internal/security/enrollment.go"), "utf8");
    // Enrollement refusé sans clé pinnée + ECDH contre la clé pinnée
    expect(enroll).toMatch(/serverPublicKeyPEM == ""/);
    expect(enroll).toContain("pinnedServerKey");
  });

  it("should dedup action requests by request_id (idempotency)", () => {
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(content).toContain("idemReserve");
    expect(content).toContain("idemComplete");
  });

  it("should have restricted systemd sandbox without blocking sudo/apt", () => {
    // Unité systemd embarquée dans le script d'install réellement servi.
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    // AmbientCapabilities donnent les caps au non-root agent
    expect(content).toContain("AmbientCapabilities");
    expect(content).toContain("CAP_NET_RAW");
    // Pas de CapabilityBoundingSet : bloquerait sudo+apt (chown, fowner, etc.)
    expect(content).not.toContain("CapabilityBoundingSet=");
    // Pas de ProtectSystem=strict : casserait les écritures sudo (apt/netplan/users)
    expect(content).not.toContain("ProtectSystem=strict");
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

describe("Privileged user actions gating (SSH keys / sudo)", () => {
  const svc = resolve(backendSrc, "services/privileged-actions.ts");

  it("should define a privileged-actions service", () => {
    expect(existsSync(svc)).toBe(true);
  });

  it("should gate the three out-of-band persistence actions", () => {
    const content = readFileSync(svc, "utf8");
    expect(content).toContain('"user.update_sudo"');
    expect(content).toContain('"sshkey.add"');
    expect(content).toContain('"sshkey.remove"');
  });

  it("should treat user.create with sudo=true as privileged (no bypass)", () => {
    const content = readFileSync(svc, "utf8");
    expect(content).toMatch(/user\.create.*params\?\.sudo === true/s);
  });

  it("should be disabled by default (explicit ALLOW_USER_PRIVILEGE_MGMT=true)", () => {
    const content = readFileSync(svc, "utf8");
    expect(content).toContain("ALLOW_USER_PRIVILEGE_MGMT");
    expect(content).toMatch(/=== "true"/);
  });

  it("should require ADMIN role even when enabled", () => {
    const content = readFileSync(svc, "utf8");
    expect(content).toMatch(/userRole !== "ADMIN"/);
  });

  it("should be enforced inside dispatchAction (covers all dispatch paths)", () => {
    const content = readFileSync(
      resolve(backendSrc, "services/action-dispatcher.ts"),
      "utf8"
    );
    expect(content).toContain("checkPrivilegedAction");
    expect(content).toMatch(
      /checkPrivilegedAction\(\s*action\.action_id,\s*userRole,\s*action\.params/s
    );
  });

  it("should propagate the caller role from action routes", () => {
    const content = readFileSync(resolve(backendSrc, "routes/actions.ts"), "utf8");
    expect(content).toMatch(/dispatchAction\([^)]*user\?\.role/s);
  });

  it("should NOT include privileged actions in the bulk allow-list", () => {
    const content = readFileSync(resolve(backendSrc, "routes/bulk.ts"), "utf8");
    expect(content).not.toContain("sshkey.add");
    expect(content).not.toContain("user.update_sudo");
  });

  it("should expose the feature flag to the frontend via /api/auth/config", () => {
    const content = readFileSync(resolve(backendSrc, "routes/auth.ts"), "utf8");
    expect(content).toContain("userPrivilegeMgmt");
  });

  it("should gate the frontend controls behind ADMIN + feature flag", () => {
    const detail = readFileSync(
      resolve(frontendSrc, "pages/MachineDetail.tsx"),
      "utf8"
    );
    expect(detail).toMatch(
      /canManagePrivileges[\s\S]*isAdmin[\s\S]*userPrivilegeMgmt/
    );
    const tab = readFileSync(resolve(frontendSrc, "components/UsersTab.tsx"), "utf8");
    expect(tab).toContain("canManagePrivileges");
  });

  it("should document the flag in .env.example (default false)", () => {
    const content = readFileSync(resolve(rootDir, ".env.example"), "utf8");
    expect(content).toMatch(/ALLOW_USER_PRIVILEGE_MGMT=false/);
  });
});
