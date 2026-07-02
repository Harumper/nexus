// Gating of "out-of-band persistence" actions: adding/removing SSH keys and
// toggling the sudo group. Unlike the other actions (firewall, services,
// reboot…) which stay within Nexus's scope (traced, revocable, dependent on the
// agent), these three create access that SURVIVES the agent's uninstallation and
// is no longer revocable by Nexus.
//
// Double lock:
//   1. Disabled by default — ALLOW_USER_PRIVILEGE_MGMT=true is required.
//   2. Reserved for the ADMIN role, even when the flag is enabled.
//
// The check is applied in dispatchAction() — so it covers ALL the dispatch
// paths (/actions/sync, /actions, /bulk, batch).

import { READ_ONLY_ACTIONS as READ_ONLY_ACTION_LIST } from "./machine-manager.js";

export const PRIVILEGED_USER_ACTIONS = new Set<string>([
  "user.update_sudo",
  "sshkey.add",
  "sshkey.remove",
]);

// Read-only actions (single source of truth, machine-manager.ts). A READONLY
// user can invoke ONLY these.
const READ_ONLY_ACTIONS = new Set<string>(READ_ONLY_ACTION_LIST);

// Actions so dangerous that they require ADMIN even though they stay within
// Nexus's scope (revocable, traced):
//   - script.execute  = arbitrary root execution on the target machine.
//   - process.kill (NEXUS-AGENT-004) = DESTRUCTIVE primitive with arbitrary impact
//     (killing any PID = DoS / data loss of the workload, without supervised
//     recovery). Its only runtime protection is a DENYLIST of critical services
//     (process_kill.go), incomplete by nature: an unlisted workload (custom DB,
//     broker, business app, another reverse-proxy) is killable without a guard.
//     The ADMIN gate covers this residual. Consistent with script.execute, the other
//     member of the ALLOW_REMOTE_SCRIPT bucket (REMOTE_SCRIPT_ACTIONS) — both root
//     primitives with arbitrary impact now require the same role.
//   - logs.configure_shipping = redirects egress of ALL system logs to an
//     arbitrary endpoint (data-exfiltration vector); logs.install_shipper adds a
//     third-party apt repo + installs software fleet-wide (supply-chain/infra
//     decision). Both require ADMIN. logs.disable_shipping stays OPERATOR — it is
//     the SAFE direction (stops egress), a normal remediation. logs.shipping_status
//     is read-only (READ_ONLY_ACTIONS).
export const ADMIN_ONLY_ACTIONS = new Set<string>([
  "script.execute",
  "process.kill",
  "logs.configure_shipping",
  "logs.install_shipper",
]);

// Remote script execution = arbitrary root (kill-chain amplifier). Opt-in
// DISABLED by default, on top of ADMIN-only: a locked-down fleet has no script
// execution path, even for an ADMIN, as long as the flag is off. Lock independent
// of the signature (local key, agent side) and of the sudoers capability (line
// omitted at install) — all three must be present. process.kill
// NEXUS-AGENT-004 (0.8): process.kill joins the set — opt-in default-off, like
// script.execute (raw PID kill = dangerous primitive; the Go guard
// process_kill.go additionally refuses the agent and critical services).
export const REMOTE_SCRIPT_ACTIONS = new Set<string>(["script.execute", "process.kill"]);

// Enabled only if ALLOW_REMOTE_SCRIPT is explicitly "true".
export function isRemoteScriptAllowed(): boolean {
  return (process.env.ALLOW_REMOTE_SCRIPT || "").toLowerCase() === "true";
}

// Central gate (applied in dispatchAction → covers sync/async/bulk/batch):
// when the flag is off, the action is refused for ALL (including internal
// calls), because the entire feature is disabled.
export function checkRemoteScriptAction(actionId: string): {
  allowed: boolean;
  reason?: string;
} {
  if (!REMOTE_SCRIPT_ACTIONS.has(actionId)) return { allowed: true };
  if (!isRemoteScriptAllowed()) {
    return {
      allowed: false,
      reason: `Action '${actionId}' is disabled. Set ALLOW_REMOTE_SCRIPT=true to enable remote script execution (ADMIN-only, signed scripts).`,
    };
  }
  return { allowed: true };
}

// Per-action RBAC, applied centrally in dispatchAction() — so it covers ALL the
// dispatch paths (/actions/sync, /actions, /bulk, batch).
//
// IMPORTANT about userRole === undefined: this is the signature of an internal
// SYSTEM call (agent-upgrade, alert-engine health poll) — never triggered
// directly by an unauthenticated user (the HTTP routes that initiate them are
// guarded separately, e.g. requireAdmin on the upgrade). Any call from an
// authenticated user ALWAYS carries a role (both local and Keycloak JWTs
// include `role`), so the restriction below does apply to users. We therefore
// treat undefined as a trusted internal call, and any unknown role as
// fail-closed.
export function checkRoleForAction(
  actionId: string,
  userRole?: string
): { allowed: boolean; reason?: string } {
  // Internal system call (no role) → trusted.
  if (userRole === undefined) return { allowed: true };

  // ADMIN: everything.
  if (userRole === "ADMIN") return { allowed: true };

  // READONLY: read-only actions only.
  if (userRole === "READONLY") {
    if (READ_ONLY_ACTIONS.has(actionId)) return { allowed: true };
    return {
      allowed: false,
      reason: `Action '${actionId}' requires OPERATOR or ADMIN role (read-only account).`,
    };
  }

  // OPERATOR: mutations allowed, except the ADMIN-reserved actions.
  if (userRole === "OPERATOR") {
    if (ADMIN_ONLY_ACTIONS.has(actionId)) {
      return {
        allowed: false,
        reason: `Action '${actionId}' requires ADMIN role.`,
      };
    }
    return { allowed: true };
  }

  // Unknown role → fail-closed.
  return {
    allowed: false,
    reason: `Action '${actionId}' not permitted for role '${userRole}'.`,
  };
}

// Audit redaction: some action params reveal infrastructure that must NOT be
// retained in the central Nexus DB. logs.configure_shipping carries the Loki
// destination (host/port/tenant); persisting it would let a Nexus-DB compromise
// map where every machine ships its logs — a ready-made target list for an
// attacker to tamper with or cover their tracks. We keep the audit EVENT
// (who / when / which action) but scrub the destination. Trade-off: the audit no
// longer shows "to where" a machine was pointed, only that it was (re)configured.
const AUDIT_REDACT_KEYS: Record<string, string[]> = {
  "logs.configure_shipping": ["loki_host", "loki_port", "tenant"],
};

// Returns a copy of params safe to persist in the audit log (sensitive keys for
// this action replaced by "[redacted]"). Non-redacted actions pass through.
export function redactAuditParams(
  actionId: string,
  params?: Record<string, unknown>
): Record<string, unknown> {
  const src = params ?? {};
  const keys = AUDIT_REDACT_KEYS[actionId];
  if (!keys) return src;
  const out: Record<string, unknown> = { ...src };
  for (const k of keys) {
    if (k in out) out[k] = "[redacted]";
  }
  return out;
}

// Enabled only if the env variable is explicitly "true".
// Any other value (absent, "false", "0"…) → disabled.
export function isUserPrivilegeMgmtEnabled(): boolean {
  return (process.env.ALLOW_USER_PRIVILEGE_MGMT || "").toLowerCase() === "true";
}

// An action is "privileged" if it grants/revokes persistent access:
//   - sudo toggle (user.update_sudo)
//   - SSH keys (sshkey.add / sshkey.remove)
//   - creating a user DIRECTLY in the sudo group
//     (user.create with params.sudo === true) — otherwise it's a trivial
//     bypass of the sudo toggle.
export function isPrivilegedUserAction(
  actionId: string,
  params?: Record<string, unknown>
): boolean {
  if (PRIVILEGED_USER_ACTIONS.has(actionId)) return true;
  if (actionId === "user.create" && params?.sudo === true) return true;
  return false;
}

// Returns { allowed } for a given action and caller role.
// userRole may be undefined (internal system call) → treated as non-ADMIN, so
// refused for privileged actions (fail-closed).
export function checkPrivilegedAction(
  actionId: string,
  userRole?: string,
  params?: Record<string, unknown>
): { allowed: boolean; reason?: string } {
  if (!isPrivilegedUserAction(actionId, params)) {
    return { allowed: true };
  }

  if (!isUserPrivilegeMgmtEnabled()) {
    return {
      allowed: false,
      reason: `Action '${actionId}' is disabled. Set ALLOW_USER_PRIVILEGE_MGMT=true to enable user privilege management (SSH keys / sudo).`,
    };
  }

  if (userRole !== "ADMIN") {
    return {
      allowed: false,
      reason: `Action '${actionId}' requires ADMIN role.`,
    };
  }

  return { allowed: true };
}
