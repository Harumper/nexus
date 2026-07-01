# Nexus — Threat Model

> **Status.** First open-source disclosure artifact. Describes the threat model of
> Nexus as it is *actually implemented* (verified against the code, `master` branch),
> not as an intention.
>
> **How to read this document.** The main body is pragmatic: what an operator
> must understand and do to deploy Nexus securely. The **"For the auditor"** callouts
> descend to the file and function level for anyone who wants to
> verify the claims. Read the body; open the callouts if you are evaluating.
>
> **This document is honest by construction.** The most important section is not
> "what is protected" (§5) but **"what is NOT protected" (§6)**. A threat
> model that only describes its strengths is a marketing brochure.

---

## 1. Overview & scope

Nexus is a control plane for a fleet of Linux servers. It has two halves:

- **The backend** (control plane): a web application + API. An operator connects to it
  via a browser, sees the state of the machines, and triggers actions (restart a
  service, apply a firewall rule, install a package, add a user…).
- **The agent** (`nexus-agent`): a Go binary installed on each managed machine. It
  receives actions from the backend over WebSocket, executes them, and reports back
  state/metrics.

An action is not a mere "read a file": these are **root** operations
(firewall, systemd services, packages, users, SSH, netplan). That is the whole point of the
product, and it is what defines its threat model.

**In scope for this document:**
- The agent ↔ backend trust channel (enrollment, runtime, updates).
- The confinement of what the agent can do on its host.
- The backend's web boundary (authz, HTTP inputs/outputs, WebSocket).

**Out of scope (handled elsewhere or not managed by Nexus):**
- The security of the host OS under the agent (kernel hardening, physical security).
- The security of the operator's browser and workstation.
- The security of the deployment infrastructure (Docker, Traefik, PostgreSQL) beyond
  the configuration variables that Nexus mandates.
- The external identity provider (Keycloak), treated as a trusted dependency.

---

## 2. Protected assets

In decreasing order of severity if compromised:

1. **The ability to execute root actions on the fleet.** This is the supreme asset. Whoever
   can issue a valid `action.request` to an agent controls that machine as root.
2. **The agent's identity** (`agent.key`): the ECDSA key that proves "I am the agent
   for machine X". Stealing it allows impersonating an agent.
3. **The backend's signing secrets** (`JWT_SECRET`, `ECDSA_MASTER_SECRET`): they
   forge operator session tokens and sign server→agent messages. Breaking them
   allows forging an ADMIN role or agent orders.
4. **The root trust keys**: the ECDSA server key (pinning at enrollment —
   private on the backend side, encrypted at rest by `ECDSA_MASTER_SECRET`), the minisign
   release key (auto-upgrade), and the script signing key (the latter two generated
   offline by the operator). These are the roots: compromising them respectively bypasses
   the pinning, the signed auto-upgrade, and `script.execute`.
5. **Channel confidentiality**: the metrics, the inventory, and the content of
   actions in transit.
6. **Audit integrity**: the log of actions executed by the agent.

---

## 3. Attacker model

Nexus is designed against the following attackers:

| Attacker | Position | What they want |
|---|---|---|
| **On-path network** | Between the agent and the backend (LAN, ISP, TLS MITM) | Steal the enrollment token, inject/replay orders, downgrade the protocol, intercept traffic |
| **Unauthenticated web** | Reaches the API/dashboard from the Internet | Bypass auth, CSWSH, SSRF, scraping `/metrics` |
| **Under-privileged operator** | Valid READONLY or OPERATOR account | Escalate rights beyond their role (mutations, privileged actions, script) |
| **Key file thief** | Has exfiltrated `agent.key` *alone* (without the rest of the disk) | Reuse the key on another machine / out of context |
| **Backend pushing a binary** | The backend (or an attacker driving it) triggers an auto-upgrade | Push an unsigned root agent binary |

### Explicitly OUTSIDE the attacker model

These attackers exist; Nexus **does not claim** to defend against them. Saying so is as
important as listing the defenses:

- **An attacker already root (or the `nexus-agent` user) on an agent's host.** They are
  already at the top of that machine. They can re-derive the key, read the agent's memory,
  etc. There is nothing to protect against them *on that machine* — they already have it.
- **An attacker holding a full disk snapshot/backup** of an agent's host. See §6:
  encryption at rest does not cover them.
- **A backend fully compromised with respect to the fleet.** See §4-A: a trusted
  backend *can* command the agents — that is the model, not a flaw. What is
  protected is the auto-upgrade (offline signing) and the integrity of the agent
  identity; not the backend's ability to issue legitimate actions.
- **Mutually distrusting tenants on the same instance.** See §4-B: there is
  no tenant isolation. This is not an attacker being repelled, it is a
  configuration not to be used.
- **Supply-chain compromise** (the source repository, the CI, the Go toolchain)
  — out of scope for this document.

---

## 4. Trust model — the two central claims

Everything else follows from these two claims. If you retain only two things from this
document, let it be these.

### A. An enrolled agent = root on its host

A Nexus agent executes root actions (firewall, services, packages, users, SSH)
via a compiled *privhelper* and `sudo`. **Enrolling an agent on a machine means entrusting
that machine to the backend operator.** Whoever controls the backend can, by
construction, act as root on all enrolled machines.

**This is not a flaw — it is the product's function.** A control plane that
administers servers *must* be able to administer them. The practical consequences:

- The backend is the highest-value asset. Treat it as you would treat a
  configuration-management server (Ansible Tower, etc.): restricted access, hardened,
  monitored.
- Only enroll an agent on a machine you are willing to entrust to the backend
  operator.
- Agent confinement (§5) does not *reduce* this power — it **bounds the surface**:
  the agent can only perform the defined actions, through verified paths, without an
  exploitable wildcard. But the whole set of these actions remains, by nature, root
  control.

### B. A Nexus instance = a single trust domain

Nexus has **no per-user or per-tenant isolation.** Authorization is a single
global RBAC ladder (`ADMIN` > `OPERATOR` > `READONLY`). There is no `ownerId`
or `projectId` on machines: **any authenticated account sees and — depending on its role —
acts on the entire fleet.**

> ⚠️ **Do NOT deploy a single Nexus instance for teams/customers that do not mutually
> trust each other.** Any OPERATOR can act on any host;
> any READONLY can read all hosts. For distinct trust
> domains, run **separate Nexus instances.**

A (positive) consequence of this choice: there is *no* per-user object boundary to
cross, so **no "IDOR on machines"** — *by design*. The risk is not
horizontal escalation between tenants; it is believing in an isolation that does not exist.

*(Reference: finding WEB-AUTHZ-006, already documented in the README.)*

---

## 5. What is protected, and how

Two foundations: **(1) the channel trust root** agent↔backend, and **(2) the
agent's confinement** on its host. Plus the backend's **web boundary**.

### 5.1 The trust root — "authenticity guaranteed at every age of the key"

This was the central axis of the internal audit: rebuilding trust at the four moments of
the identity key's life — bootstrap, runtime, rest, and update.

#### Bootstrap (enrollment) — no on-path key swap, no replay

When an agent enrolls, its request is **sealed** (ECIES/ECDH P-256 encryption) toward the
**pinned server key** that the operator deployed with the agent and pinned locally. An on-path
attacker therefore can neither read the enrollment token, nor substitute their own key: the
encryption is done *against the locally pinned key*, never against a key received from the network.
The request carries a timestamp + a nonce bound to the signed proof → a replayed
enrollment is rejected.

> **For the auditor.** Seal: `agent/internal/security/seal.go:65-93` (ephemeral ECDH P-256
> against the pinned key, HKDF `nexus-enroll:<id>`, AES-256-GCM; ephemeral private key never
> persisted). Opening: `backend/src/services/enrollment-seal.ts:13-30`. The key returned
> by the server is used only for an *equality check* against the pinned one, never
> as a derivation base: `agent/internal/security/enrollment.go:181-211`. Anti-replay:
> nonce+timestamp in the sealed payload (`enrollment.go:64-99`), domain-separated composite
> proof `nexus-enroll-proof:v2:…` (`crypto.go:198-200`), nonce memorized only
> *after* proof of authenticity (`backend/src/services/enrollment.ts:131-159`).
> *Findings ENROLLMENT-001/002.*

**Pinning is mandatory**, with no silent fallback: the agent `log.Fatal`s at boot if
no server key is configured; `Enroll()` refuses without it; `install-agent.sh`
requires `--server-public-key-file`.

> **For the auditor.** `agent/cmd/nexus-agent/main.go:211-215` (log.Fatal),
> `enrollment.go:108-110` (refusal), `scripts/install-agent.sh:265-269` (flag required).
> *Finding ENROLLMENT-003 (GUARD).*

#### Runtime channel — versioned protocol v2, signed message by message

On every connection, agent and backend perform an **ECDHE X25519 handshake** (forward
secrecy: compromising a long-term key does not decrypt past sessions). Then,
**each authenticated message is verified by signature**, with an anti-replay nonce, and the
**protocol version is bound into the signature** (an attacker cannot downgrade
to a weaker v1 protocol).

> **For the auditor.** Handshake: `agent/internal/security/handshake.go:40-111`,
> `backend/src/services/session-handshake.ts:57-62` (ephemeral X25519 keys, never
> persisted). Per-message verification: the backend re-verifies *literally every* authenticated
> message against the pubkey re-read from the DB (`backend/src/websocket/handler.ts:89-95`, no
> cache — finding CRYPTO-003). On the agent side, the server signature is verified on
> messages triggering a sensitive action (`action.request` `main.go:409-421`,
> `action.confirm` `main.go:433-445`) and on the handshake ack; `ping`/`error` are not
> signed but trigger no action. Anti-replay: `server_verify.go:39-58` (nonce
> memorized after verification, CRYPTO-005). Version at the head of the signed payload:
> `crypto.go:184-191`, verified first (`server_verify.go:70-72`). *Findings
> CRYPTO-003/004/005.*

#### Rest — `agent.key` encrypted, bound to the machine

The identity key is **encrypted at rest** (AES-256-GCM) with a key derived from the
host's `machine-id` + an install salt. An *isolated* copy of the key file, without
the machine context, is unusable; copied onto another machine, it does not
decrypt.

> **For the auditor.** `agent/internal/security/keystore.go:53-102` (`wrappingKey()` =
> HKDF over `/etc/machine-id` + salt `/etc/nexus/agent-keysalt`, fail-closed if machine-id
> is empty or salt < 16 bytes; format `nonce:ciphertext`, cleartext PEM never on disk;
> legacy auto-migration with no cleartext residue `:187-231`). Salt generated at
> `install-agent.sh:668-672` (`root:nexus-agent 0640`). **Crucial limitation in §6.**
> *Finding CRYPTO-001.*

#### Summit — minisign-signed auto-upgrade, fail-closed

An agent update is installed only if the binary is accompanied by a
**detached minisign signature**, verified against a release key **deployed offline
by the operator** (never provided by the backend). Missing signature, invalid signature, or
absent release key ⇒ **refusal** (fail-closed), before any installation. The download
URL is pinned on the enrolled backend (anti-SSRF / anti-token-exfiltration).

> **For the auditor.** `agent/internal/actions/agent_upgrade.go`: local key
> `/etc/nexus/release.pub` (`:116,198-201`), refusal if signature/key absent (`:198-213`),
> verification BEFORE install + deletion of the staging area if invalid (`:296-299`), pinning of the
> `download_url` on the pinned host before sending the bearer (`validateDownloadURL :33-49`,
> `:231-236`). Anti-rollback (`:215-229`), anti-TOCTOU re-hash before install (`:317-324`).
> `LoadMinisignAcceptList` always returns an error rather than an empty list
> (`minisign_verify.go:23-44`). *Findings SELF-UPGRADE-001 to 005.*

### 5.2 Agent confinement — bounding the root surface

The agent's power is root (claim A), but its *surface* is narrow and verified.

- **The agent process runs stripped down.** Non-root user `nexus-agent`, no
  ambient *capability*, and `CAP_DAC_READ_SEARCH` + `CAP_SYS_PTRACE` removed from the bounding
  set of the whole unit (one cannot bypass file permissions nor inspect
  other processes). Complementary systemd hardening: `ProtectHome`, `PrivateTmp`,
  `ProtectKernel*`, `RestrictRealtime`, `LockPersonality`, `RestrictAddressFamilies`…

> **For the auditor.** `scripts/install-agent.sh:707-784` (heredoc of the `.service`):
> `AmbientCapabilities=` empty (`:753`), `CapabilityBoundingSet=~CAP_DAC_READ_SEARCH
> CAP_SYS_PTRACE` (`:764`). *Honest nuance: `~` is a **negation**, not an allow-list*
> — the default bounding set minus those two caps. An allow-list would also cap the
> `sudo` children (apt/netplan/useradd) and break the actions. `SystemCallFilter` is
> deliberately absent (SUID sudo required). Confinement therefore rests on sudoers +
> targeted `Protect*`, **not** on a seccomp sandbox. *Finding AGENT-002.*

- **Privileged mutations go through a compiled privhelper**, not through sudoers
  wildcards. The drop-in `/etc/sudoers.d/nexus-agent` does not allow `useradd *` nor
  `install …*/…` to an arbitrary destination; it calls a root-owned Go binary (no
  invocable shell interpreter) that **validates its inputs**: strict POSIX
  login, `--` that terminates option parsing (`-o`/`-u 0` impossible), sources resolved by
  `realpath` confined to the agent state directory, fixed or validated destinations.

> **For the auditor.** Privhelper: `agent/internal/privhelper/privhelper.go` (useradd
> `:114-131`, install-* `:133-183` via `resolveUnderStaging :78-92` + `EvalSymlinks`, svc
> `:221-240`). Sudoers: `install-agent.sh:344-531` (`env_reset`+`secure_path` scoped
> `:356-357`, privhelper line `:408`, `NOEXEC:` on apt/dnf `:379-392`, validated `visudo -cf`
> before atomic install `:545-550`). *Honest nuance: some legitimate **argument** wildcards
> remain (`ufw allow *`, `apt-mark hold *`, `userdel -r *`, `cat
> /home/*/.ssh/authorized_keys`, `pvs -o *`) — none invoke an interpreter, but they are
> not argument-exact; and the `install`s to a **literal destination** write
> agent-controlled content to fixed paths (`/etc/fail2ban/jail.local`, etc.).*
> *Findings AGENT-001/003/006/008/009.*

- **`find` pinned.** The `ssl.scan` action enumerates certificates via a `find` with a fixed
  predicate (frozen roots, `-maxdepth 4 -type f -name *.pem -o … *.crt`), byte-identical to the
  sudoers line — no injectable `-exec`.

> **For the auditor.** `agent/internal/actions/ssl_scan.go:111-124`, identical to
> `install-agent.sh:487`. *Finding AGENT-001.*

- **`script.execute` is opt-in, disabled by default, behind three independent
  locks** (each blocks on its own): (a) the `nexus-script` sudoers line is only written
  with `--allow-remote-script` at install time; (b) the backend refuses at dispatch without
  `ALLOW_REMOTE_SCRIPT=true`; (c) the agent verifies a detached minisign signature of the
  script (`script_sig`) before any write/execution. And `script.execute` is
  **ADMIN-only**.

> **For the auditor.** (a) `install-agent.sh:534-540`; (b)
> `backend/src/services/privileged-actions.ts:39-61` + central dispatch
> `action-dispatcher.ts:67-70`; (c) `agent/internal/actions/script_execute.go:44-61` +
> `minisign_verify.go:23-44` (fail-closed). ADMIN-only: `ADMIN_ONLY_ACTIONS =
> {"script.execute", "process.kill"}` (`privileged-actions.ts:29`). **`process.kill` is
> also ADMIN-only**: it is an *arbitrary-impact destructive* primitive (killing
> any PID = DoS/data loss of the workload, with no supervised recovery), and its
> only runtime protection is a **denylist of critical services (incomplete by
> nature**: an unlisted workload — custom DB, broker, business app, another reverse-proxy —
> is killable without a guard). The ADMIN gate covers this residual. It is consistent with
> `script.execute`, the other member of the `ALLOW_REMOTE_SCRIPT` bucket: both arbitrary-impact
> root primitives require the same role. Reminder: `process.kill` additionally refuses its
> own PID and that of the critical services resolved live (§ self-protection).
> *Findings AGENT-004/005.*

- **The agent cannot sabotage itself.** Stop/restart of the `nexus-agent` service
  refused; `process.kill` refuses its own PID and the MainPID (resolved live) of the
  critical services (ssh, docker, postgres, nginx, containerd…). Defense in depth
  over 3 layers (Go action, privhelper, kill guard).

> **For the auditor.** `agent/internal/actions/services.go:23-154`,
> `privhelper.go:45-49,234-238`, `process_kill.go:33-43,74-76,109-111`. *Nuance: the kill
> guard protects a **list** of critical services resolved live; a critical service
> off the list (a reverse-proxy other than nginx, e.g.) is not covered.*

### 5.3 The backend's web boundary

- **Authorization is server-side authoritative**, on *all* dispatch paths
  (sync, async, bulk, batch). The frontend (and the *feature flags* exposed by
  `/api/auth/config`) is **purely indicative** — never the authority.

  > **Invariant for contributors.** The RBAC distinguishes two worlds at the
  > dispatch point: a call carrying a `userRole` (request from an authenticated operator, subject to
  > the ADMIN/OPERATOR/READONLY ladder) and a call **without a role** (`userRole === undefined`),
  > treated as a **trusted internal system call** that bypasses the RBAC (used
  > by the alert-engine, the auto-upgrade…). **The entire safety of the RBAC rests on this
  > invariant: no user-reachable path must call `dispatchAction`
  > without a role.** It holds today because every issued JWT carries a role and because each
  > HTTP route propagates `user.role`. *If you add an entry point to `dispatchAction`,
  > it MUST pass the caller's role — otherwise you open a complete bypass of the
  > RBAC.* The privileged actions (§ below) are deliberately fail-closed even for
  > `undefined`, but the rest of the mutations are not.

> **For the auditor.** `dispatchAction()` applies at the head, before any I/O:
> `checkRoleForAction` (READONLY bounded to `READ_ONLY_ACTIONS`, OPERATOR mutations, ADMIN
> `script.execute`/`process.kill`), `checkPrivilegedAction`, `checkRemoteScriptAction`,
> `checkCriticalProtection` — `backend/src/services/action-dispatcher.ts:39-90`. All the
> callers pass the role (`routes/actions.ts`, `routes/bulk.ts`, `routes/security.ts`).
> The `userRole === undefined` bypass is at `privileged-actions.ts:78-79`. Indicative flags
> documented at `routes/auth.ts:31-38`. *Findings WEB-AUTHZ-004/007.*

- **Anti-CSWSH on the dashboard WebSocket.** The Origin is validated in exact-match against
  `FRONTEND_URL`; unknown origin ⇒ rejection (fail-closed).

> **For the auditor.** `backend/src/websocket/server.ts:230-235`. *Honest nuance: the
> **agent** WebSocket (`/ws/agent`) has, for its part, **no** Origin check — this is
> intentional: an agent is a non-browser client with no Origin, authenticated by
> handshake/signature, not by Origin (`server.ts:111-115,202-214`). CSWSH is a browser
> threat; it applies only to the dashboard.* *Finding CONTROL-PLANE-001.*

- **SSRF guard on all outbound HTTP traffic.** Every outbound URL goes through
  `assertSafeOutboundUrl` + `safeFetch`: http/https scheme only, refusal of
  embedded credentials, **blocking of private-network targets** (10/8, 172.16/12,
  192.168/16, 169.254/16, loopback, CGNAT…), refusal of redirects, and **synchronous
  blocking of literal IPs** (the fix that closes the undici bypass, which
  skips the DNS hook for a literal). Anti-rebinding via pinning of the resolved
  address.

> **For the auditor.** `backend/src/services/net-guard.ts:28-166`. Call-sites all guarded:
> webhook (`webhook.ts:30,47,71`), notifications (`notifications.ts:353,357`), nautilus
> (`nautilus-integration.ts:148,159`), apt-catalog (`apt-catalog.ts:89,90`). **Outside
> the guard's scope (cf. §6): `keycloak.ts` (JWKS, URL from the admin env
> `KEYCLOAK_URL`) and `email.ts` (SMTP, non-HTTP, host from an admin-only setting).**
> *Finding WEB-AUTHZ-001.*

- **`/metrics` closed.** If `METRICS_TOKEN` is defined, access requires a `Bearer` (compared
  in constant time); absent/wrong token ⇒ 401. *Additive* to the network scoping.

> **For the auditor.** `backend/src/services/prometheus.ts:204-220`. *Nuance: without
> `METRICS_TOKEN`, the endpoint rests entirely on network scoping — see §7.* *Finding
> WEB-AUTHZ-005.*

- **Anti-mass-assignment.** The `PUT` of an alert rule accepts only fields
  explicitly listed (schema `additionalProperties:false` + allow-list, never a spread
  of the body), and is ADMIN-only.

> **For the auditor.** `backend/src/routes/alerts.ts:145-203`. *Finding WEB-AUTHZ-003.*

- **User-privilege actions locked.** `sshkey.add/remove`,
  `user.update_sudo`, and `user.create` with `sudo:true` create access that *survives the
  uninstallation of the agent* (non-revocable by Nexus). They are **disabled by
  default** (`ALLOW_USER_PRIVILEGE_MGMT=true` to enable) **and ADMIN-only**, gated
  centrally in the dispatch (covers sync/async/bulk/batch). The reads
  (`user.list`/`sshkey.list`) remain open.

> **For the auditor.** `backend/src/services/privileged-actions.ts:16-159` (double lock
> flag + ADMIN), gate `action-dispatcher.ts:55-62`. The `user.create{sudo:true}` variant
> is indeed treated as privileged (`:123-130`).

---

## 6. What is NOT protected — assumed limitations

**This is the most important section of this document.** Each limitation below is real
and assumed. Reading them means knowing what Nexus *does not* do for you.

### 6.1 Theft of a full disk / snapshot / backup

The at-rest encryption of `agent.key` (§5.1) protects an *isolated* copy of the key file.
It **does NOT protect a full disk snapshot or backup** of an agent's host. The
`machine-id` and the salt travel *with the disk*: an attacker holding a complete image
re-derives the wrapping key and decrypts `agent.key`.

**Concretely**: a Proxmox snapshot, a PBS backup, or any full-image backup of an
agent's host **contains that agent's identity**. Treat these backups as secrets.

Only a hardware **TPM 2.0** seal (non-exportable key) would close this case — **not
implemented** (roadmap, hardware opt-in: DEF-1). *(Finding RB-4 / CRYPTO-001.)*

### 6.2 No isolation between tenants

Reminder of claim B (§4): one instance = a single trust domain. Every
OPERATOR acts on the whole host, every READONLY reads the whole host. **This is not a flaw
fixable by configuration** — it is the model. For distrusting tenants: separate
instances.

### 6.3 The anti-SSRF guard blocks the private network by default

This is a protection, but it has an **operational consequence to know** so as not
to mistake it for a bug: by default, the guard blocks any notification/HTTP output
toward a private-network target (10.x / 172.16.x / 192.168.x / 169.254.x / loopback).

- Notifying an **external** service (Discord, Slack, a public webhook) works without
  configuration.
- Notifying an **internal self-hosted** service (ntfy / Gotify / a webhook on the LAN,
  an APT mirror on 10.x) **will fail** until an **operator allow-list** exists.
  This allow-list is **not yet implemented** (top of the post-v1 roadmap). Cloud
  metadata (169.254.169.254) will never be allow-listable.

To state explicitly: if your internal notification "does not go out", it is not a
failure — it is the SSRF guard doing its job.

### 6.4 Outputs not covered by the SSRF guard: Keycloak (JWKS) and SMTP

Two outbound channels do **not** go through the anti-SSRF guard, because they are not
HTTP-to-attacker-controllable-URL traffic:

- **`KEYCLOAK_URL`** (JWKS retrieval): URL fixed by the operator in the environment,
  same trust class as `DATABASE_URL`. No attacker-controllable runtime input.
- **SMTP relay** (`email.ts`): SMTP egress (non-HTTP, therefore outside the HTTP guard), host from
  an **admin-only** setting. An internal relay is often legitimate.

These are **not** SSRF holes exploitable at runtime by an unprivileged attacker.
They are flagged out of honesty: an *administrator* who writes these settings can point
to an internal host (but an admin already has plenty of other powers). A JWKS/SMTP guard is
a later decision, not an urgent fix.

### 6.5 Compromised backend: can command, the audit is not WORM

A trusted backend *can* issue root actions (claim A). If the backend is
compromised, the attacker inherits this power. Two nuances:

- The auto-upgrade remains protected (the backend cannot push an unsigned binary — §5.1).
- The agent-side audit (journald, append-only) is *tamper-evident* with respect to the agent,
  but **an external WORM (write-once) sink is not in place.** An attacker with
  sufficient power over the log host could, eventually, alter the history. Exporting
  the logs to an external immutable sink is the operator's responsibility.

### 6.6 Attacker already root on an agent's host

Out of scope (reminder §3): they are already at the top of that machine. Agent
confinement bounds what *Nexus* makes the agent do; it does not defend a machine already
fallen.

---

## 7. Operator responsibilities

The model above **holds only if** the following conditions are true at
deployment. These are *your* responsibilities; Nexus cannot guarantee them in your stead.

### 7.1 Generate STRONG secrets — never the default values

`JWT_SECRET`, `ECDSA_MASTER_SECRET` (and `METRICS_TOKEN` if you enable it) must be
strong and unique. Breaking them allows forging an ADMIN role or agent orders (§2).

- `openssl rand -hex 32` (≈ 256 bits) at minimum, per secret, distinct from each other.
- Nexus **refuses to start** (noisy failure at boot, finding CONTROL-PLANE-005) if
  `JWT_SECRET`/`ECDSA_MASTER_SECRET` are: absent, less than 32 characters, a known
  *placeholder* value (`changeme`, `secret`, `password`, `default`, `example`… — including
  repeated/padded to reach 32 chars, e.g. `changeme_changeme_changeme_changeme`), or of
  zero entropy (a single repeated character). `METRICS_TOKEN` is optional, but **if it is
  defined** it is subject to the same checks (fatal if weak).

> **Why this guard.** Length alone is not enough: a placeholder copied from the
> docs clears 32 characters while remaining guessable in advance. Same principle as the
> mandatory `wss://` guard — a default that silently breaks security is worse than a noisy
> failure. Detail: a strong secret that happens to *contain* a placeholder word (with
> entropy around it) is still accepted; only secrets *composed solely* of placeholders
> are rejected.

### 7.2 Provision the trust keys

Three roots of trust — but they are **not** provisioned in the same way, and
the distinction matters.

**Generated offline by you, never via the UI** (the private key must never reach
a backend that could appropriate it):

- **Minisign release key** (auto-upgrade) — public deployed on each agent
  (`/etc/nexus/release.pub`); private offline, in the vault.
- **Script signing key** (`script.execute`, optional) — public
  (`/etc/nexus/script-signing.pub`); private offline.

**Managed by the backend, protected by you:**

- **ECDSA server key** (pinning at enrollment) — **you do not generate it**: the backend
  generates a P-256 pair *per machine*, exposes the public one (pinned on the agent at
  `/etc/nexus/server-public-key.pem`, delivered in the bootstrap command) and keeps the
  private one on the server side, **encrypted at rest by `ECDSA_MASTER_SECRET`**. Your role:
  provision a **strong `ECDSA_MASTER_SECRET`** (§7.1) — which protects all the server
  private keys — and verify that the pinned pubkey indeed matches that of the
  machine.

*(Exact commands, paths, permissions, rotation: see [OPERATOR-KEYS.md](OPERATOR-KEYS.md).)*

### 7.3 Deploy over `wss://` (encrypted transport)

The agent **refuses** a cleartext transport (`ws://`/`http://`) without an explicit dev override —
a guard already in place (noisy failure at install and at runtime). Do not bypass this
guard in production: `ws://` would reopen precisely the token theft + key swap that the
enrollment seal closes.

### 7.4 Configure the REQUIRED variables (checklist)

A default "safe for local dev" often breaks **silently** in production. Minimal
checklist (absent/local default ⇒ must produce a visible failure or warning):

- [ ] `JWT_SECRET` — ≥ 32 chars, unique (fatal failure at boot if weak).
- [ ] `ECDSA_MASTER_SECRET` — ≥ 32 chars, distinct from `JWT_SECRET` (fatal failure at boot).
- [ ] `DATABASE_URL` — fatal failure if absent.
- [ ] `AGENT_BACKEND_URL` — `https://<domain>`; over `http://`, the agent refuses (noisy).
- [ ] `FRONTEND_URL` — exact `https://<domain>` (no trailing `/`, no `:443`); warning at
      boot if local. Governs CORS + the CSWSH Origin allow-list (§5.3): a bad setting
      makes it reject the real domain in a loop.
- [ ] `TRUSTED_PROXY_HOPS` — consistent with your proxy chain (otherwise the real IP of the
      agents is mis-resolved).
- [ ] `METRICS_TOKEN` — defined if `/metrics` is reachable beyond the trusted
      scraper (otherwise the endpoint rests on network scoping alone).
- [ ] `TLS_ENABLED=false` if a reverse-proxy (Traefik) terminates the TLS (otherwise double-TLS /
      self-signed cert that the agent refuses).

### 7.5 Understand what you are accepting

- Each enrolled agent = a machine entrusted to the backend operator (§4-A).
- One instance = one trust domain; not for distrusting tenants (§4-B).
- Full backups/snapshots of an agent's host contain its identity (§6.1).
- Treat the backend as the most sensitive asset of your fleet.

---

## Appendix A — For evaluators: findings ↔ code mapping

| Domain | Findings | Verdict (verified on `master`) |
|---|---|---|
| Sealed bootstrap + anti-replay | ENROLLMENT-001/002/003 | Confirmed |
| Channel v2 (ECDHE, per-message, anti-downgrade) | CRYPTO-003/004/005 | Confirmed (agent: signature on sensitive messages + ack; `ping`/`error` inert, unsigned) |
| `agent.key` at-rest | CRYPTO-001 | Confirmed — **does not cover the full snapshot (§6.1)** |
| Minisign auto-upgrade fail-closed | SELF-UPGRADE-001→005 | Confirmed |
| Bounding set / Ambient | AGENT-002 | Confirmed (negation, not allow-list; no seccomp) |
| Sudoers + privhelper + pinned find | AGENT-001/003/006/008/009 | Confirmed (benign residual arg wildcards documented) |
| `script.execute` 3 locks + ADMIN-only | AGENT-004/005 | Confirmed (`process.kill` now ADMIN-only as well — destructive primitive with an incomplete denylist) |
| Server-authoritative RBAC | WEB-AUTHZ-004/007 | Confirmed |
| CSWSH Origin | CONTROL-PLANE-001 | Confirmed **for the dashboard**; agent WS exempt by design |
| SSRF egress guard (+ literal IP) | WEB-AUTHZ-001 | Confirmed; **Keycloak/SMTP out of scope (§6.4)** |
| Authenticated `/metrics` | WEB-AUTHZ-005 | Confirmed (without token → network scoping alone) |
| Anti-mass-assignment | WEB-AUTHZ-003 | Confirmed |
| User privileges off-by-default + ADMIN | (privileged-actions) | Confirmed |
| No tenant isolation | WEB-AUTHZ-006 | Confirmed — assumed limitation (§6.2) |

Known limitations/deferrals: at-rest snapshot (DEF-1 / TPM), internal SSRF allow-list (post-v1),
automatic key rotation (CRYPTO-002, covered today by the manual re-enroll),
end-to-end DER signatures (CRYPTO-007, hygiene, v2 deployment), external WORM audit (§6.5).

Beyond the automated tests (e2e suite + Go unit tests + Go↔Node interop vectors), the
properties that require a real host/network/fleet (bounding set under systemd, full v2 flow
enroll→handshake→heartbeat, hardened sudoers, `/metrics` scoping, SSRF guard on a real network…)
were verified under real conditions on a staging environment — 12 checkpoints
covered. The present document is self-sufficient; these deployment
verifications are kept outside this repository.
