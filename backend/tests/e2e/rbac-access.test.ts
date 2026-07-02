import { describe, it, expect, afterEach } from "vitest";
import {
  checkRoleForAction,
  checkPrivilegedAction,
  isPrivilegedUserAction,
  redactAuditParams,
  ADMIN_ONLY_ACTIONS,
} from "../../src/services/privileged-actions.js";
import { READ_ONLY_ACTIONS } from "../../src/services/machine-manager.js";

// BEHAVIORAL test of the central RBAC (the functions actually called by
// dispatchAction). A bug here = root RCE / escalation; the 74 structural
// "security" tests would not catch it (they only do toContain on the source).

const READ_ONLY = READ_ONLY_ACTIONS[0]; // a real read-only action
const MUTATION = "firewall.allow"; // mutation, absent from the read-only list
const ADMIN_ONLY = [...ADMIN_ONLY_ACTIONS][0]; // e.g. script.execute

describe("checkRoleForAction — RBAC by role", () => {
  it("READONLY: allowed on a read-only action", () => {
    expect(checkRoleForAction(READ_ONLY, "READONLY").allowed).toBe(true);
  });
  it("READONLY: DENIED on a mutation", () => {
    expect(checkRoleForAction(MUTATION, "READONLY").allowed).toBe(false);
  });
  it("READONLY: DENIED on script.execute (no RCE for a reader)", () => {
    expect(checkRoleForAction(ADMIN_ONLY, "READONLY").allowed).toBe(false);
  });
  it("OPERATOR: allowed on a mutation", () => {
    expect(checkRoleForAction(MUTATION, "OPERATOR").allowed).toBe(true);
  });
  it("OPERATOR: DENIED on an ADMIN-only action (script.execute)", () => {
    expect(checkRoleForAction(ADMIN_ONLY, "OPERATOR").allowed).toBe(false);
  });
  it("ADMIN: everything allowed, including script.execute", () => {
    expect(checkRoleForAction(ADMIN_ONLY, "ADMIN").allowed).toBe(true);
    expect(checkRoleForAction(MUTATION, "ADMIN").allowed).toBe(true);
  });
  it("unknown role: fail-closed (denied)", () => {
    expect(checkRoleForAction(MUTATION, "WIZARD").allowed).toBe(false);
  });
  it("undefined (internal system call): allowed", () => {
    expect(checkRoleForAction(ADMIN_ONLY, undefined).allowed).toBe(true);
  });
});

// NEXUS-AGENT-004 — process.kill is ADMIN-only (destructive primitive with
// arbitrary impact, protected only by an incomplete denylist on the agent side →
// the ADMIN gate covers the residual; consistent with script.execute, the other
// member of the ALLOW_REMOTE_SCRIPT bucket). RED→GREEN: as long as process.kill
// was only in REMOTE_SCRIPT_ACTIONS (and not ADMIN_ONLY_ACTIONS), an OPERATOR
// would pass this gate.
describe("checkRoleForAction — process.kill ADMIN-only (NEXUS-AGENT-004)", () => {
  it("process.kill is indeed marked ADMIN-only", () => {
    expect(ADMIN_ONLY_ACTIONS.has("process.kill")).toBe(true);
  });
  it("OPERATOR: DENIED on process.kill", () => {
    expect(checkRoleForAction("process.kill", "OPERATOR").allowed).toBe(false);
  });
  it("READONLY: DENIED on process.kill", () => {
    expect(checkRoleForAction("process.kill", "READONLY").allowed).toBe(false);
  });
  it("ADMIN: allowed on process.kill", () => {
    expect(checkRoleForAction("process.kill", "ADMIN").allowed).toBe(true);
  });
});

describe("checkPrivilegedAction — out-of-band access (SSH keys / sudo)", () => {
  const prev = process.env.ALLOW_USER_PRIVILEGE_MGMT;
  afterEach(() => {
    if (prev === undefined) delete process.env.ALLOW_USER_PRIVILEGE_MGMT;
    else process.env.ALLOW_USER_PRIVILEGE_MGMT = prev;
  });

  it("isPrivilegedUserAction: sshkey.add and user.create+sudo are privileged", () => {
    expect(isPrivilegedUserAction("sshkey.add")).toBe(true);
    expect(isPrivilegedUserAction("user.create", { sudo: true })).toBe(true);
    expect(isPrivilegedUserAction("user.create", { sudo: false })).toBe(false);
    expect(isPrivilegedUserAction("firewall.allow")).toBe(false);
  });

  it("non-privileged action: always allowed (independent of the flag)", () => {
    delete process.env.ALLOW_USER_PRIVILEGE_MGMT;
    expect(checkPrivilegedAction("firewall.allow", "ADMIN").allowed).toBe(true);
  });

  it("privileged + flag OFF: DENIED even for ADMIN", () => {
    delete process.env.ALLOW_USER_PRIVILEGE_MGMT;
    expect(checkPrivilegedAction("sshkey.add", "ADMIN").allowed).toBe(false);
  });

  it("privileged + flag ON + non-ADMIN: DENIED", () => {
    process.env.ALLOW_USER_PRIVILEGE_MGMT = "true";
    expect(checkPrivilegedAction("sshkey.add", "OPERATOR").allowed).toBe(false);
  });

  it("privileged + flag ON + ADMIN: allowed", () => {
    process.env.ALLOW_USER_PRIVILEGE_MGMT = "true";
    expect(checkPrivilegedAction("sshkey.add", "ADMIN").allowed).toBe(true);
  });

  it("user.create+sudo + flag ON + non-ADMIN: DENIED (sudo bypass protection)", () => {
    process.env.ALLOW_USER_PRIVILEGE_MGMT = "true";
    expect(checkPrivilegedAction("user.create", "OPERATOR", { sudo: true }).allowed).toBe(false);
  });
});

// Audit redaction: the Loki destination of logs.configure_shipping must NOT be
// persisted in the audit log — a Nexus-DB compromise would otherwise expose the
// fleet's log destinations. The event is kept; the destination is scrubbed.
describe("redactAuditParams — audit confidentiality of log destinations", () => {
  it("logs.configure_shipping: host/port/tenant are redacted, tls kept", () => {
    const out = redactAuditParams("logs.configure_shipping", {
      loki_host: "10.0.10.103",
      loki_port: "3100",
      tenant: "team-a",
      tls: true,
    });
    expect(out.loki_host).toBe("[redacted]");
    expect(out.loki_port).toBe("[redacted]");
    expect(out.tenant).toBe("[redacted]");
    expect(out.tls).toBe(true); // non-identifying → kept
  });

  it("does not leak the destination string anywhere in the audit payload", () => {
    const out = redactAuditParams("logs.configure_shipping", { loki_host: "10.0.10.103", loki_port: "3100" });
    expect(JSON.stringify(out)).not.toContain("10.0.10.103");
  });

  it("other actions pass through unchanged (no accidental scrubbing)", () => {
    const params = { name: "nginx" };
    expect(redactAuditParams("system.service_restart", params)).toEqual(params);
  });

  it("undefined params → empty object (no crash)", () => {
    expect(redactAuditParams("logs.configure_shipping", undefined)).toEqual({});
  });
});
