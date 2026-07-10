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

  it("should derive the session key with a domain-separated HKDF label (ECDHE)", () => {
    // CRYPTO-004: the old static ECDH (label "nexus-shared-secret") is replaced
    // by an ephemeral ECDHE X25519 handshake; the session key is derived via
    // HKDF with domain-separation by machine_id ("nexus-session:<id>"), identical
    // on the backend side (interop verified). Empty salt on both sides.
    const agentHs = readFileSync(resolve(agentDir, "internal/security/handshake.go"), "utf8");
    expect(agentHs).toContain("nexus-session:");
  });

  it("should fully verify incoming action.request (signature + nonce + timestamp)", () => {
    // action.request dispatches ALL mutating actions (script.execute,
    // package.install, user.create, firewall...). It must be verified like
    // action.confirm: VerifyServerMessage checks the backend ECDSA signature +
    // the nonce (anti-replay) + the timestamp. A plain timestamp check is not
    // enough (encrypted frame replayable within the window).
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    const actionReqIdx = content.indexOf("case transport.TypeActionRequest:");
    const actionConfIdx = content.indexOf("case transport.TypeActionConfirm:");
    expect(actionReqIdx).toBeGreaterThan(-1);
    // The action.request block must call VerifyServerMessage before dispatching.
    const actionReqBlock = content.slice(actionReqIdx, actionConfIdx);
    expect(actionReqBlock).toContain("VerifyServerMessage");
    expect(actionReqBlock).toContain("serverPublicKey");
  });

  it("should enforce per-action RBAC centrally in dispatchAction", () => {
    // C1: without per-action RBAC, any authenticated user (READONLY/OPERATOR)
    // could dispatch script.execute = root RCE. The check must be in
    // dispatchAction (covers sync/async/bulk/batch), not only at the route level.
    const dispatcher = readFileSync(resolve(backendSrc, "services/action-dispatcher.ts"), "utf8");
    expect(dispatcher).toContain("checkRoleForAction");

    const priv = readFileSync(resolve(backendSrc, "services/privileged-actions.ts"), "utf8");
    expect(priv).toContain("checkRoleForAction");
    // script.execute must be reserved to ADMIN.
    expect(priv).toContain("ADMIN_ONLY_ACTIONS");
    expect(priv).toMatch(/ADMIN_ONLY_ACTIONS[\s\S]*script\.execute/);
    // READONLY bound to the read-only list (single source: READ_ONLY_ACTIONS,
    // machine-manager.ts — formerly PROBE_ALLOWED_ACTIONS before the PROBE type
    // was removed; same list, real "read-only" role).
    expect(priv).toContain("READ_ONLY_ACTIONS");
  });

  it("enforces access centrally at backend dispatch (single agent type, no agent-side probe gate)", () => {
    // The PROBE type was removed: a single agent type. Access control is no
    // longer a whitelist duplicated on the agent side (defense-in-depth removed
    // with PROBE) but the central RBAC of dispatchAction (READONLY bound to
    // READ_ONLY_ACTIONS, OPERATOR for mutations, ADMIN-only on script.execute).
    // We verify that the agent NO LONGER carries a type gate, and that the
    // backend holds the boundary.
    const mainGo = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(mainGo).not.toContain("probeAllowedActions");
    expect(mainGo).not.toContain("action not allowed in probe mode");
    const mm = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(mm).toContain("READ_ONLY_ACTIONS");
    expect(mm).not.toContain("PROBE_ALLOWED_ACTIONS");
  });

  it("should use /var/lib/nexus-agent (StateDirectory) for scripts instead of /tmp", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/script_execute.go"), "utf8");
    expect(content).toContain("/var/lib/nexus-agent");
    expect(content).not.toMatch(/CreateTemp\("",/);
  });

  it("should have secure sudoers without dangerous wildcards", () => {
    // Script actually served to the agents (not the old agent/deploy/install.sh).
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    // apt-get update should NOT have wildcard
    expect(content).toMatch(/apt-get update\n/);
    // NEXUS-AGENT-010: package install/remove no longer use a raw `apt-get
    // install *` sudoers wildcard (whose NOEXEC backstop both broke apt's method
    // exec and mis-targeted the real -o/-c/changelog injection vectors). They are
    // routed through the compiled privhelper, so the wildcards must be ABSENT and
    // the privhelper wrapper present.
    expect(content).not.toMatch(/apt-get (install|remove) -y -qq \*/);
    expect(content).not.toMatch(/(dnf|yum) (install|remove) -y -q \*/);
    expect(content).toContain("/usr/local/bin/nexus-agent privhelper *");
    // kill should use explicit signals
    expect(content).toContain("/bin/kill -SIGTERM");
    // Scripts in dedicated dir, not /tmp. Since NEXUS-AGENT-005 the sudoers rule
    // `bash …/nexus-script-*.sh` is OPT-IN (--allow-remote-script) and emitted via
    // $AGENT_SCRIPT_DIR outside the static heredoc: so we no longer check for a
    // literal path always present, but that the dedicated state directory and the
    // name pattern remain used (the "no /tmp" guarantee on the agent side is
    // tested separately on script_execute.go).
    expect(content).toMatch(/AGENT_SCRIPT_DIR="\/var\/lib\/nexus-agent"/);
    expect(content).toContain("nexus-script-*.sh");
    // Uses mktemp instead of hardcoded /tmp path
    expect(content).toContain("mktemp");
    // upgrade/update must use EXACT args (no trailing wildcard → no -o injection)
    expect(content).not.toMatch(/apt-get upgrade -y \*/);
    expect(content).toContain("/usr/bin/apt-get upgrade -y -q");
    // TLS private keys must NEVER be readable via sudo cat
    expect(content).not.toContain("/etc/ssl/private/");
    expect(content).not.toMatch(/cat \/etc\/letsencrypt\/live\/\*\/\*\.pem/);
    expect(content).not.toMatch(/cat \/etc\/nginx\/ssl\/\*$/m);
  });

  it("should enforce mandatory server key pinning in the agent", () => {
    const mainGo = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    // Fatal at boot if no server key (no longer a mere WARNING)
    expect(mainGo).toMatch(/ServerPublicKey == ""/);
    expect(mainGo).toContain("log.Fatal");
    const enroll = readFileSync(resolve(agentDir, "internal/security/enrollment.go"), "utf8");
    // Enrollment refused without a pinned key + ECDH against the pinned key
    expect(enroll).toMatch(/serverPublicKeyPEM == ""/);
    expect(enroll).toContain("pinnedServerKey");
  });

  it("should dedup action requests by request_id (idempotency)", () => {
    const content = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(content).toContain("idemReserve");
    expect(content).toContain("idemComplete");
  });

  it("should have restricted systemd sandbox without blocking sudo/apt", () => {
    // systemd unit embedded in the install script actually served.
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    // NEXUS-AGENT-002 — least-privilege: the non-root agent process has NO
    // dangerous ambient capability (DAC_READ_SEARCH / SYS_PTRACE removed).
    const ambient = content.split("\n").find((l) => l.startsWith("AmbientCapabilities=")) ?? "";
    expect(ambient).not.toMatch(/CAP_DAC_READ_SEARCH|CAP_SYS_PTRACE/);
    // Bounding set in NEGATION (~): removes the 2 attack caps from the whole unit
    // (drift-guard) WITHOUT capping the sudo children — an allow-list would have
    // broken apt/netplan/useradd (chown, fowner, dac_override, setuid…).
    expect(content).toMatch(/CapabilityBoundingSet=~[^\n]*CAP_DAC_READ_SEARCH[^\n]*CAP_SYS_PTRACE/);
    // No ProtectSystem=strict: would break the sudo writes (apt/netplan/users)
    expect(content).not.toContain("ProtectSystem=strict");
    // Sandbox stays active via the other directives
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

describe("Security hardening module (Lynis audit — MVP)", () => {
  it("should have a read-only security.audit agent action that parses Lynis", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/security_audit.go"), "utf8");
    expect(content).toContain('"security.audit"');
    // Read-only: non-interactive audit (--quick), streamed output, never any remediation
    expect(content).toContain("audit");
    expect(content).toContain("--quick");
    expect(content).toContain("lynis-report.dat");
    expect(content).toContain("hardening_index");
    expect(content).toContain("OnSecurityProgress"); // streaming console live
  });

  it("should classify security.audit as read-only (READ_ONLY_ACTIONS)", () => {
    const mgr = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(mgr).toContain("READ_ONLY_ACTIONS");
    expect(mgr).toContain('"security.audit"');
  });

  it("should whitelist Lynis in sudoers (audit + report read), fixed paths", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("/lynis audit system --quick --no-colors");
    expect(content).toContain("/bin/cat /var/log/lynis-report.dat");
  });

  it("should expose the security audit in the frontend (SecurityTab + api)", () => {
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("SecurityAuditDialog"); // progress modal
    expect(tab).toContain("hardening_index");
    const dialog = readFileSync(resolve(frontendSrc, "components/SecurityAuditDialog.tsx"), "utf8");
    expect(dialog).toContain("securityAudit");
    const apiFile = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    // securityAudit calls the dedicated /security/audit route (async dispatch).
    expect(apiFile).toMatch(/securityAudit[\s\S]*security\/audit/);
  });
});

describe("Security hardening remediations (Phase 2 — fail2ban / auto-updates)", () => {
  it("should define fail2ban + auto-updates remediation agent actions", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/security_harden.go"), "utf8");
    expect(content).toContain('"security.harden_fail2ban"');
    expect(content).toContain('"security.enable_auto_updates"');
    expect(content).toContain("jail.local");
    expect(content).toContain("unattended-upgrades");
  });

  it("should NOT classify the remediation actions as read-only (they mutate)", () => {
    const mgr = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(mgr).not.toContain("security.harden_fail2ban");
    expect(mgr).not.toContain("security.enable_auto_updates");
  });

  it("should whitelist the remediation file writes + systemctl enable in sudoers", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("/etc/fail2ban/jail.local");
    expect(content).toContain("/etc/apt/apt.conf.d/20auto-upgrades");
    // AGENT-006: fail2ban/unattended-upgrades enable now goes through the
    // compiled privhelper svc op (no raw `systemctl enable *` in sudoers).
    const harden = readFileSync(resolve(rootDir, "agent/internal/actions/security_harden.go"), "utf8");
    expect(harden).toMatch(/privhelper", "svc", "enable", "fail2ban"/);
  });

  it("should wire 1-click remediation in the frontend (api + SecurityTab)", () => {
    const apiFile = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(apiFile).toMatch(/hardenFail2ban[\s\S]*security\.harden_fail2ban/);
    expect(apiFile).toMatch(/enableAutoUpdates[\s\S]*security\.enable_auto_updates/);
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("hardenFail2ban");
    // i18n: title externalized to key security:remediations.title (FR label in the JSON).
    expect(tab).toContain("remediations.title");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/security.json"), "utf8");
    expect(fr).toContain("Remédiations recommandées");
  });
});

describe("SSH hardening with watchdog-revert (Phase 2.2)", () => {
  it("should follow the watchdog-revert pattern (snapshot/confirm/recover) like firewall/netplan", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/ssh_harden.go"), "utf8");
    expect(content).toContain('"sshd.harden"');
    expect(content).toContain("registerPendingSshd");
    expect(content).toContain("HandleSshdConfirm");
    expect(content).toContain("RecoverPendingSshd");
    expect(content).toContain("time.AfterFunc");
    // Anti-lock-out: sshd -t BEFORE reload, and reload via SIGHUP (not systemctl)
    expect(content).toMatch(/sshd.*-t/);
    expect(content).toContain("SIGHUP");
    expect(content).toContain("99-nexus-hardening.conf");
    // Does NOT touch auth (no disabling of password/root login in the drop-in)
    expect(content).not.toContain("PasswordAuthentication no");
    expect(content).not.toContain("PermitRootLogin no");
  });

  it("should wire the dead-man's switch and confirm dispatch in main.go", () => {
    const main = readFileSync(resolve(agentDir, "cmd/nexus-agent/main.go"), "utf8");
    expect(main).toContain("RecoverPendingSshd");
    expect(main).toMatch(/sshd-[\s\S]*HandleSshdConfirm/);
  });

  it("should keep systemctl reload/restart of ssh BLOCKED in sudoers (anti-lockout)", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    // sshd -t + drop-in install/rm whitelisted
    expect(content).toContain("/usr/sbin/sshd -t");
    expect(content).toContain("/etc/ssh/sshd_config.d/99-nexus-hardening.conf");
    // AGENT-006: anti-lockout now enforced in the compiled privhelper (option-
    // injection-proof), not an option-sensitive sudoers pattern. ssh/sshd are
    // refused for stop/restart/reload/disable in code.
    const priv = readFileSync(resolve(rootDir, "agent/internal/privhelper/privhelper.go"), "utf8");
    expect(priv).toMatch(/svcProtectedUnits/);
    expect(priv).toMatch(/"ssh":\s*true/);
    expect(priv).toMatch(/"sshd":\s*true/);
  });

  it("should NOT classify sshd.harden as read-only (it mutates)", () => {
    const mgr = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(mgr).not.toContain('"sshd.harden"');
  });

  it("should expose a signed sshd/confirm backend route", () => {
    const route = readFileSync(resolve(backendSrc, "routes/ssh.ts"), "utf8");
    expect(route).toContain("/api/machines/:id/sshd/confirm");
    expect(route).toContain("action.confirm");
    const index = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(index).toContain("sshRoutes");
  });

  it("should wire SSH hardening + watchdog confirm in the frontend", () => {
    const apiFile = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(apiFile).toMatch(/sshdHarden[\s\S]*sshd\.harden/);
    expect(apiFile).toContain("sshdConfirm");
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("sshdHarden");
    // i18n: confirmation button externalized to key security:watchdog.confirmButton.
    expect(tab).toContain("watchdog.confirmButton");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/security.json"), "utf8");
    expect(fr).toContain("Confirmer");
  });
});

describe("Firewall assistant (Phase 2.3 — listening services -> policy)", () => {
  it("should have a read-only network.listening_services probe (ss)", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/network_listening.go"), "utf8");
    expect(content).toContain('"network.listening_services"');
    expect(content).toContain("parseSsListening");
    expect(content).toContain("-Htlnp");
    expect(content).toContain("isExposedAddr");
  });

  it("should classify listening_services as read-only (READ_ONLY_ACTIONS)", () => {
    const mgr = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(mgr).toContain("READ_ONLY_ACTIONS");
    expect(mgr).toContain('"network.listening_services"');
  });

  it("should apply a firewall policy via the existing watchdog (one snapshot, revert on failure)", () => {
    const content = readFileSync(resolve(agentDir, "internal/actions/firewall.go"), "utf8");
    expect(content).toContain('"firewall.apply_policy"');
    expect(content).toContain("registerPendingRevert"); // reuses the existing watchdog
    expect(content).toContain("restoreFromSnapshot"); // immediate revert on failure
    expect(content).toContain("firewallPortRegex"); // strict port validation
  });

  it("should NOT classify firewall.apply_policy as read-only (it mutates)", () => {
    const mgr = readFileSync(resolve(backendSrc, "services/machine-manager.ts"), "utf8");
    expect(mgr).not.toContain("firewall.apply_policy");
  });

  it("should whitelist ss in sudoers (read-only, fixed args)", () => {
    const content = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(content).toContain("/ss -Htlnp");
  });

  it("should wire the firewall assistant in the frontend (reuses firewallConfirm)", () => {
    const apiFile = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(apiFile).toMatch(/listeningServices[\s\S]*network\.listening_services/);
    expect(apiFile).toMatch(/firewallApplyPolicy[\s\S]*firewall\.apply_policy/);
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("firewallApplyPolicy");
    expect(tab).toContain("firewallConfirm"); // reused confirm
  });
});

describe("Security scan history & trend (Phase 3)", () => {
  it("should define a SecurityScan model + migration (no db push)", () => {
    const schema = readFileSync(resolve(backendSrc, "../prisma/schema.prisma"), "utf8");
    expect(schema).toContain("model SecurityScan {");
    expect(schema).toContain("hardeningIndex");
    expect(schema).toMatch(/securityScans\s+SecurityScan\[\]/); // relation on the Machine side
    const mig = resolve(backendSrc, "../prisma/migrations/20260624120000_add_security_scan/migration.sql");
    expect(existsSync(mig)).toBe(true);
    expect(readFileSync(mig, "utf8")).toContain('CREATE TABLE "SecurityScan"');
  });

  it("should persist scans and expose history via dedicated routes", () => {
    const route = readFileSync(resolve(backendSrc, "routes/security.ts"), "utf8");
    expect(route).toContain("/api/machines/:id/security/audit");
    expect(route).toContain("/api/machines/:id/security/scans");
    // Persistence happens on receipt of the agent response (async),
    // in the security-scan service (called by handleActionResponse).
    const svc = readFileSync(resolve(backendSrc, "services/security-scan.ts"), "utf8");
    expect(svc).toContain("securityScan.create");
    const handler = readFileSync(resolve(backendSrc, "websocket/handler.ts"), "utf8");
    expect(handler).toContain("recordSecurityScan");
    const index = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(index).toContain("securityRoutes");
  });

  it("should stream the audit live via WebSocket (async, no blocking HTTP / 504)", () => {
    // The audit is dispatched async (returns request_id); progress and result
    // arrive via WS — no more waitForResponse on the route side.
    const route = readFileSync(resolve(backendSrc, "routes/security.ts"), "utf8");
    expect(route).not.toContain("waitForResponse");
    const handler = readFileSync(resolve(backendSrc, "websocket/handler.ts"), "utf8");
    expect(handler).toContain("security.audit.progress");
    expect(handler).toContain("security.audit.result");
    // The progress modal listens to the WS stream (live console, like the agent upgrade).
    const dialog = readFileSync(resolve(frontendSrc, "components/SecurityAuditDialog.tsx"), "utf8");
    expect(dialog).toContain("useWebSocket");
    expect(dialog).toContain("security.audit.progress");
  });

  it("should render a hardening trend chart from history in the frontend", () => {
    const apiFile = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(apiFile).toMatch(/securityAudit[\s\S]*security\/audit/); // persistent route
    expect(apiFile).toContain("securityScans");
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("HardeningTrend");
    // i18n: title externalized to key security:trend.title.
    expect(tab).toContain("trend.title");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/security.json"), "utf8");
    expect(fr).toContain("Tendance de l'indice");
  });
});

describe("Hardening regression alert (Phase 3.2b)", () => {
  it("should add the HARDENING_INDEX_BELOW enum value + migration", () => {
    const schema = readFileSync(resolve(backendSrc, "../prisma/schema.prisma"), "utf8");
    expect(schema).toContain("HARDENING_INDEX_BELOW");
    const mig = readFileSync(
      resolve(backendSrc, "../prisma/migrations/20260624130000_add_hardening_alert/migration.sql"),
      "utf8"
    );
    expect(mig).toMatch(/ALTER TYPE "AlertConditionType" ADD VALUE 'HARDENING_INDEX_BELOW'/);
  });

  it("should evaluate against the latest persisted SecurityScan (no agent poll)", () => {
    const engine = readFileSync(resolve(backendSrc, "services/alert-engine.ts"), "utf8");
    expect(engine).toContain("evaluateHardeningAlerts");
    expect(engine).toContain("HARDENING_CHECK_CONDITIONS");
    // Reads the latest persisted scan, no dispatchActionSync here.
    expect(engine).toMatch(/securityScan\.findFirst/);
  });

  it("should wire the hardening evaluator (periodic + after each audit)", () => {
    const index = readFileSync(resolve(backendSrc, "index.ts"), "utf8");
    expect(index).toContain("evaluateHardeningAlerts"); // periodic interval
    // Triggered after each audit: recordSecurityScan (on receipt of the agent
    // response) calls evaluateHardeningAlerts.
    const svc = readFileSync(resolve(backendSrc, "services/security-scan.ts"), "utf8");
    expect(svc).toContain("evaluateHardeningAlerts");
  });

  it("should validate the new condition in the alerts route + expose it in the UI", () => {
    const alerts = readFileSync(resolve(backendSrc, "routes/alerts.ts"), "utf8");
    expect(alerts).toContain("HARDENING_INDEX_BELOW");
    const create = readFileSync(resolve(frontendSrc, "pages/AlertCreate.tsx"), "utf8");
    expect(create).toContain("HARDENING_INDEX_BELOW");
  });
});

describe("Security — legal login banner remediation (1-click)", () => {
  it("agent: action security.set_login_banner + state detection", () => {
    const h = readFileSync(resolve(agentDir, "internal/actions/security_harden.go"), "utf8");
    expect(h).toContain('"security.set_login_banner"');
    expect(h).toContain("SetLoginBannerAction");
    expect(h).toContain("func loginBannerSet()");
    expect(h).toContain("/etc/issue.net");
    expect(h).toContain('params["text"]'); // configurable banner
    const audit = readFileSync(resolve(agentDir, "internal/actions/security_audit.go"), "utf8");
    expect(audit).toContain('parsed["login_banner_set"]');
  });

  it("sudoers: install whitelisted for /etc/issue and /etc/issue.net", () => {
    const s = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(s).toMatch(/sec-banner-\*\.tmp \/etc\/issue\b/);
    expect(s).toContain("sec-banner-*.tmp /etc/issue.net");
  });

  it("frontend: api + remediation card", () => {
    const api = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(api).toContain("setLoginBanner");
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("login_banner_set");
    // i18n: label externalized to key security:remediations.bannerLabel (FR in the JSON).
    expect(tab).toContain("remediations.bannerLabel");
    const frSec = readFileSync(resolve(frontendSrc, "i18n/locales/fr/security.json"), "utf8");
    expect(frSec).toContain("Bannière légale");
  });
});

describe("Security — hardening remediations + inline doc", () => {
  it("agent: core_dumps + login_defs actions", () => {
    const h = readFileSync(resolve(agentDir, "internal/actions/security_harden.go"), "utf8");
    expect(h).toContain('"security.disable_core_dumps"');
    expect(h).toContain('"security.harden_login_defs"');
    expect(h).toContain("func setLoginDef(");
    expect(h).toContain("fs.suid_dumpable = 0");
    const audit = readFileSync(resolve(agentDir, "internal/actions/security_audit.go"), "utf8");
    expect(audit).toContain('parsed["core_dumps_disabled"]');
    expect(audit).toContain('parsed["login_defs_hardened"]');
  });

  it("sudoers: install + sysctl whitelisted", () => {
    const s = readFileSync(resolve(rootDir, "scripts/install-agent.sh"), "utf8");
    expect(s).toContain("99-nexus-nocore.conf");
    expect(s).toContain("/usr/sbin/sysctl -p /etc/sysctl.d/99-nexus-coredump.conf");
    expect(s).toContain("sec-logindefs-*.tmp /etc/login.defs");
  });

  it("frontend: cards + Lynis doc link on each finding", () => {
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("core_dumps_disabled");
    expect(tab).toContain("login_defs_hardened");
    expect(tab).toContain("cisofy.com/lynis/controls/");
  });
});

describe("Firewall: exclusion of Docker-managed ports", () => {
  it("agent: marks docker_managed (docker-proxy/dockerd)", () => {
    const n = readFileSync(resolve(agentDir, "internal/actions/network_listening.go"), "utf8");
    expect(n).toContain("DockerManaged");
    expect(n).toContain("docker-proxy");
    expect(n).toContain('json:"docker_managed"');
  });
  it("frontend: separates and excludes Docker services from the ufw policy", () => {
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("docker_managed");
    expect(tab).toContain("fwDockerServices");
    // i18n: hint externalized to key security:firewallWizard.dockerHint (FR in the JSON).
    expect(tab).toContain("firewallWizard.dockerHint");
    const fr = readFileSync(resolve(frontendSrc, "i18n/locales/fr/security.json"), "utf8");
    expect(fr).toContain("chaîne DOCKER");
  });
});

describe("SSH hardening: preview (dry-run) before applying", () => {
  it("agent: sshd.harden handles dry_run (returns the content, without applying)", () => {
    const s = readFileSync(resolve(agentDir, "internal/actions/ssh_harden.go"), "utf8");
    expect(s).toContain('params["dry_run"]');
    expect(s).toContain('"content":');
  });
  it("agent: generic dry-run (core-dumps/login.defs/auto-updates)", () => {
    const h = readFileSync(resolve(agentDir, "internal/actions/security_harden.go"), "utf8");
    expect(h).toContain("func dryRunChanges");
    expect(h).toContain("func isDryRun");
  });

  it("frontend: generic inline preview (dry-run) + View button + panel", () => {
    const api = readFileSync(resolve(frontendSrc, "services/api.ts"), "utf8");
    expect(api).toContain("remediationPreview");
    expect(api).toContain("dry_run: true");
    const tab = readFileSync(resolve(frontendSrc, "components/SecurityTab.tsx"), "utf8");
    expect(tab).toContain("togglePreview");
    expect(tab).toContain("PreviewOverlay");
  });
});
