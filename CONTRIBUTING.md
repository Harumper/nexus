# Contributing to Nexus

Thanks for your interest! Nexus is a control plane that administers servers **as
root** — rigor, especially around security, comes before speed. This guide is
short; please read it before opening an issue or a pull request.

## How to contribute

- **Discussion / bugs / ideas**: open an **issue** on GitHub. Describe the
  context, what you expected, and what you observed.
- **Code / docs**: open a **pull request** on GitHub. Keep it focused (one topic
  per PR), explain the *why*, and add or update tests where relevant (the backend
  e2e suite and the Go tests).
- **Security vulnerabilities**: see the dedicated section below — **do not open a
  public issue.**

## Opening a PR means accepting the CLA

Every pull request implies acceptance of the **Contributor License Agreement**
([`CLA.md`](CLA.md)). In short: you keep ownership of your contributions, but you
grant a broad license (including a relicensing right) that lets the project
evolve, possibly toward a future dual license. Read [`CLA.md`](CLA.md) before your
first contribution.

## Before touching security: read the threat model

Nexus has an explicit threat model: [`THREAT-MODEL.md`](THREAT-MODEL.md)
(currently in French; an English translation is a welcome post-publication
contribution). If your change touches enrollment, the agent↔backend channel,
agent confinement (sudoers, privhelper), RBAC, SSRF, or authentication, **read it
first** — it defines what is protected, what is not, and the invariants you must
not break.

Example of an invariant to respect (§5.3, "Invariant pour les contributeurs"):
> All RBAC safety rests on the fact that **no user-reachable path calls
> `dispatchAction` without a role**. If you add an entry point to
> `dispatchAction`, it **must** propagate the caller's role — otherwise you open a
> complete RBAC bypass.

Architecture conventions (the removed capability model, the single agent type,
watchdog patterns, sudoers rules, etc.) are described in `CLAUDE.md` — worth
skimming before a structural PR.

## Reporting a vulnerability — private channel

**Never open a public issue for a security vulnerability.** A public issue exposes
the problem before a fix exists.

Use the private channel described in [`SECURITY.md`](SECURITY.md) (GitHub Private
Vulnerability Reporting). The scope — what counts as a real vulnerability versus
an assumed limitation — is spelled out there, linked to the threat model.

## Style & quality

- Match the style of the surrounding code (naming, comment density, the file's
  idioms).
- The backend is TypeScript (Vitest tests); the agent is Go. Make the suite pass
  (`npx vitest run` in the backend, `go test ./...` in the agent) and `tsc`
  before submitting.
- A Go code change requires rebuilding the agent; see `CLAUDE.md`.

Thank you for helping keep Nexus solid.
