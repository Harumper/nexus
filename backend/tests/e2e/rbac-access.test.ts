import { describe, it, expect, afterEach } from "vitest";
import {
  checkRoleForAction,
  checkPrivilegedAction,
  isPrivilegedUserAction,
  ADMIN_ONLY_ACTIONS,
} from "../../src/services/privileged-actions.js";
import { READ_ONLY_ACTIONS } from "../../src/services/machine-manager.js";

// Test COMPORTEMENTAL du RBAC central (les fonctions réellement appelées par
// dispatchAction). Un bug ici = RCE root / escalade ; les 74 tests structurels
// "sécu" ne le détecteraient pas (ils ne font que du toContain sur le source).

const READ_ONLY = READ_ONLY_ACTIONS[0]; // une action lecture seule réelle
const MUTATION = "firewall.allow"; // mutation, absente de la liste read-only
const ADMIN_ONLY = [...ADMIN_ONLY_ACTIONS][0]; // ex. script.execute

describe("checkRoleForAction — RBAC par rôle", () => {
  it("READONLY : autorisé sur une action lecture seule", () => {
    expect(checkRoleForAction(READ_ONLY, "READONLY").allowed).toBe(true);
  });
  it("READONLY : REFUSÉ sur une mutation", () => {
    expect(checkRoleForAction(MUTATION, "READONLY").allowed).toBe(false);
  });
  it("READONLY : REFUSÉ sur script.execute (pas de RCE pour un lecteur)", () => {
    expect(checkRoleForAction(ADMIN_ONLY, "READONLY").allowed).toBe(false);
  });
  it("OPERATOR : autorisé sur une mutation", () => {
    expect(checkRoleForAction(MUTATION, "OPERATOR").allowed).toBe(true);
  });
  it("OPERATOR : REFUSÉ sur une action ADMIN-only (script.execute)", () => {
    expect(checkRoleForAction(ADMIN_ONLY, "OPERATOR").allowed).toBe(false);
  });
  it("ADMIN : tout autorisé, y compris script.execute", () => {
    expect(checkRoleForAction(ADMIN_ONLY, "ADMIN").allowed).toBe(true);
    expect(checkRoleForAction(MUTATION, "ADMIN").allowed).toBe(true);
  });
  it("rôle inconnu : fail-closed (refusé)", () => {
    expect(checkRoleForAction(MUTATION, "WIZARD").allowed).toBe(false);
  });
  it("undefined (appel système interne) : autorisé", () => {
    expect(checkRoleForAction(ADMIN_ONLY, undefined).allowed).toBe(true);
  });
});

// NEXUS-AGENT-004 — process.kill est ADMIN-only (primitive destructrice à impact
// arbitraire, protégée seulement par une denylist incomplète côté agent → le gate
// ADMIN couvre le résiduel ; cohérent avec script.execute, l'autre membre du bucket
// ALLOW_REMOTE_SCRIPT). RED→GREEN : tant que process.kill n'était que dans
// REMOTE_SCRIPT_ACTIONS (et pas ADMIN_ONLY_ACTIONS), un OPERATOR passait ce gate.
describe("checkRoleForAction — process.kill ADMIN-only (NEXUS-AGENT-004)", () => {
  it("process.kill est bien marqué ADMIN-only", () => {
    expect(ADMIN_ONLY_ACTIONS.has("process.kill")).toBe(true);
  });
  it("OPERATOR : REFUSÉ sur process.kill", () => {
    expect(checkRoleForAction("process.kill", "OPERATOR").allowed).toBe(false);
  });
  it("READONLY : REFUSÉ sur process.kill", () => {
    expect(checkRoleForAction("process.kill", "READONLY").allowed).toBe(false);
  });
  it("ADMIN : autorisé sur process.kill", () => {
    expect(checkRoleForAction("process.kill", "ADMIN").allowed).toBe(true);
  });
});

describe("checkPrivilegedAction — accès hors-bande (SSH keys / sudo)", () => {
  const prev = process.env.ALLOW_USER_PRIVILEGE_MGMT;
  afterEach(() => {
    if (prev === undefined) delete process.env.ALLOW_USER_PRIVILEGE_MGMT;
    else process.env.ALLOW_USER_PRIVILEGE_MGMT = prev;
  });

  it("isPrivilegedUserAction : sshkey.add et user.create+sudo sont privilégiés", () => {
    expect(isPrivilegedUserAction("sshkey.add")).toBe(true);
    expect(isPrivilegedUserAction("user.create", { sudo: true })).toBe(true);
    expect(isPrivilegedUserAction("user.create", { sudo: false })).toBe(false);
    expect(isPrivilegedUserAction("firewall.allow")).toBe(false);
  });

  it("action non privilégiée : toujours autorisée (indépendant du flag)", () => {
    delete process.env.ALLOW_USER_PRIVILEGE_MGMT;
    expect(checkPrivilegedAction("firewall.allow", "ADMIN").allowed).toBe(true);
  });

  it("privilégiée + flag OFF : REFUSÉE même pour ADMIN", () => {
    delete process.env.ALLOW_USER_PRIVILEGE_MGMT;
    expect(checkPrivilegedAction("sshkey.add", "ADMIN").allowed).toBe(false);
  });

  it("privilégiée + flag ON + non-ADMIN : REFUSÉE", () => {
    process.env.ALLOW_USER_PRIVILEGE_MGMT = "true";
    expect(checkPrivilegedAction("sshkey.add", "OPERATOR").allowed).toBe(false);
  });

  it("privilégiée + flag ON + ADMIN : autorisée", () => {
    process.env.ALLOW_USER_PRIVILEGE_MGMT = "true";
    expect(checkPrivilegedAction("sshkey.add", "ADMIN").allowed).toBe(true);
  });

  it("user.create+sudo + flag ON + non-ADMIN : REFUSÉE (anti-contournement sudo)", () => {
    process.env.ALLOW_USER_PRIVILEGE_MGMT = "true";
    expect(checkPrivilegedAction("user.create", "OPERATOR", { sudo: true }).allowed).toBe(false);
  });
});
