# Security Policy

Thank you for contributing to the security of Nexus. This document explains **how to report a
vulnerability**, **what falls within scope**, and **how we handle reports**.

Nexus is a control plane that administers servers as root: its security is taken seriously. This
document is the counterpart to the [threat model](THREAT-MODEL.md) — that one describes *what is
protected and what is not*; this one describes *how to report when something does not hold up*.

## 1. Reporting a vulnerability

**Never open a public issue for a security vulnerability.** A public issue exposes the problem
before a fix exists.

Use GitHub's **private** channel: private vulnerability reporting (*Private Vulnerability
Reporting* / *Security advisories*), via the repository's **Security → Report a vulnerability**
tab. It keeps the exchange private and tracked, and encrypts the communication.

> *Note to the maintainer: this channel must be **enabled** in the repository settings
> (**Settings → Security → Private vulnerability reporting**). Until it is, the
> "Report a vulnerability" button does not appear for reporters.*

### What a good report contains

So that we can reproduce and fix quickly:

- **Version / commit** concerned (output of `git rev-parse HEAD`, or the release tag).
- Precise **reproduction steps**.
- **Impact**: what an attacker gains — which asset from the [threat model](THREAT-MODEL.md)
  (§2) is affected, which trust assumption is broken.
- A minimal **proof of concept** if possible.
- The relevant environment (agent OS, auth mode, reverse proxy…).

**Do not include** real exploitation data: no production credentials or secrets, no personal
data, no dumps. Keep any PoC strictly limited to what is necessary to demonstrate the flaw — do
not exploit beyond that, and do not touch systems that do not belong to you.

## 2. Scope — what to report, what not to report

### In scope

Anything that the [threat model](THREAT-MODEL.md) **§5 ("What is protected")** claims to
protect and which would not hold up. In particular:

- **Bypassing the root of trust** (§5.1): breaking the seal/pinning at enrollment,
  replaying an enrollment, bypassing per-message signature verification or the anti-downgrade
  of the v2 channel, bypassing the minisign verification of the auto-upgrade, or decrypting
  `agent.key` from an **isolated copy** of the key file.
- **Escaping the agent's confinement** (§5.2): obtaining root execution beyond the defined
  actions — escaping the privhelper, injection via sudoers, `find -exec`, bypassing the three
  locks of `script.execute` or the ADMIN gate of `script.execute` / `process.kill`.
- **Bypassing the web boundary** (§5.3): RBAC role elevation (reaching `dispatchAction`
  without a role, passing a READONLY/OPERATOR off as ADMIN), CSWSH on the dashboard WebSocket,
  SSRF reaching an internal target despite the guard, unauthenticated access to `/metrics` when
  a token is configured, mass assignment, etc.
- Any classic web flaw not covered above (injection, deserialization, secret leak,
  broken authentication…).

### Out of scope

Several things **look like** vulnerabilities but are **assumed and documented limits** —
reporting them adds noise without teaching anything. Before reporting, check the
[threat model](THREAT-MODEL.md) **§6 ("What is NOT protected")** and
**§3 ("outside the attacker model")**.

Known non-vulnerabilities (see the threat model for details, not copied here):

- **Theft of a full disk snapshot/backup** of an agent host → re-derivation of `agent.key`
  (§6.1). At-rest encryption only protects an *isolated* copy of the file.
- **No isolation between tenants**: any OPERATOR acts on the entire fleet, any READONLY reads
  everything (§6.2). One instance = a single trust domain, *by design*.
- **The anti-SSRF guard blocks private networks by default**: being unable to notify an
  internal service (ntfy/Gotify/LAN webhook) is not a bug (§6.3).
- **A trusted backend commands the agents as root**: this is the product's function, not a
  flaw (§4-A). Likewise, an attacker **already root** on an agent's host is explicitly
  outside the model (§3).
- Keycloak (JWKS) / SMTP egress not covered by the SSRF guard, and other points listed
  in §6.4–§6.6.

If you believe an "assumed limit" is in fact exploitable **beyond** what the threat model
describes (e.g. an SSRF bypass reaching the private network *without* an allow-list, or a key
re-derivation *without* full disk access), **it is in scope** — report it.

## 3. Supported versions

Nexus is in the process of being opened up, **pre-1.0**. Support is deliberately minimal and
honest:

| Version | Supported |
|---|---|
| Latest `master` / latest published release | ✅ |
| Earlier versions, pre-releases (`v0.0.1-staging`, etc.) | ❌ |

- Only the most recent state (up-to-date `master`, or the latest release) receives security
  fixes.
- **No backporting** of fixes to older versions while the project is pre-1.0.
- Update to the latest version before reporting — the flaw may already be fixed.

This policy will be revisited at the first stable version (1.0).

## 4. Coordinated disclosure

We follow a **coordinated** disclosure, on a **best-effort** basis (the project is run by a
small team — no contractual SLA):

1. **Acknowledgment** of your report within a reasonable time.
2. **Assessment**: we confirm (or not) the flaw and its scope, and follow up with you
   if needed.
3. **Fix**: we work on a fix and, where applicable, on an interim mitigation.
4. **Disclosure** once the fix is available, coordinated with you — ideally simultaneous
   publication of the fix and an advisory.
5. **Credit**: we are happy to credit the reporter in the advisory, if you wish (otherwise,
   anonymous reporting is respected).

In return, we ask you to **not publicly disclose** the flaw until a fix is available, and to
allow us a reasonable time to produce it.

Thank you for helping keep Nexus safe.
