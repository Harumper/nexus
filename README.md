# Nexus

Self-hosted infrastructure management platform. Agent-based, multi-machine, with real-time monitoring, alerting, and safe remote administration (firewall/netplan with watchdog-revert).

## Stack

- **Backend**: Fastify + Prisma + PostgreSQL + WebSocket
- **Agent**: Go (static binary, systemd service)
- **Frontend**: React + Vite + TypeScript
- **Auth**: local (JWT) or Keycloak OIDC
- **Communication**: ECDSA P-256 + AES-256-GCM over WebSocket

## Features

### Monitoring
- Metrics (CPU, RAM, disk, load, network) with historical charts
- Process list, top processes
- Storage (LVM: PV/VG/LV, block devices, filesystems)
- Systemd services status + failed units
- Systemd timers + cron jobs
- SSL certificates (scan Let's Encrypt, nginx, apache, haproxy)

### Administration
- System updates (apt) with progress WebSocket streaming
- Package install/remove/hold (apt-mark pinning)
- Package catalog search (Ubuntu noble) with Postgres FTS
- Service start/stop/restart
- Journalctl log viewer
- User management + SSH keys
- **Firewall ufw with watchdog-revert (60s)** — revert auto if not confirmed
- **Netplan editor with watchdog-revert (120s)** — revert auto if network lost
- Reboot + agent self-upgrade
- Protection: `nexus-agent` service cannot be stopped by itself

### Fleet operations
- **Bulk actions**: multi-select machines, dispatch in parallel (up to 100)
- Tags + groups (static/dynamic with filters)
- Profiles (UPGRADE/REBOOT/SCRIPT/PACKAGE scheduled execution)

### Alerting
11 conditions across 4 categories:
- **Metrics** (per-heartbeat): `CPU_ABOVE`, `MEMORY_ABOVE`, `DISK_ABOVE`, `LOAD_ABOVE`
- **Connectivity** (every 60s): `MACHINE_OFFLINE`
- **Health** (every 5 min): `SERVICE_FAILED`, `TIMER_FAILED`, `CRON_FAILED`, `UPDATES_AVAILABLE`
- **Security** (every 6h): `CERT_EXPIRING`

Notifications: HMAC-signed webhooks + SMTP email + WebSocket real-time broadcast.

### Safety
- **Role-based access** (`ADMIN`/`OPERATOR`/`READONLY`): one fully-capable agent type — reads vs mutations are gated centrally by role (no separate read-only "probe" machine type)
- **Critical flag** (`isCritical`): blocks `reboot`, `service_stop/restart` on critical services (docker/nginx/ssh/postgres), `package.remove` on critical packages
- **Watchdog-revert**: snapshot before mutation + 60s/120s timer + dead-man's switch at agent boot
- Sudoers whitelist (fixed paths, exact args, compiled privhelper for the risky ops). `NOEXEC` is a **targeted backstop on the package-manager `install`/`remove` wildcard only** (blocks `Pre-Invoke`-style shell-outs) — not a blanket confinement; the other lines rely on fixed paths / exact args / privhelper
- Systemd hardening: `StateDirectory`, `Protect*`, no ambient capabilities

### Authorization model — no tenant isolation (one instance = one trust domain)
Nexus has **no per-user / per-tenant isolation**. Authorization is a single global
RBAC ladder (`ADMIN` > `OPERATOR` > `READONLY`); there is **no `ownerId`/`projectId`
on machines**, so **every authenticated account sees and (per its role) acts on the
entire fleet**. There is no per-user object boundary to break out of — and so no
"IDOR on machines" — *by design*.

> ⚠️ **One Nexus instance = one trust domain.** Do **not** put machines belonging to
> different teams/customers behind a single instance expecting them to be isolated:
> any OPERATOR can act on any host, any READONLY can read every host. For separate
> trust domains, run **separate Nexus instances**. If you self-host for multiple
> tenants, this is the security model you are accepting.

### Agent key at rest — what it protects (and what it does NOT)
The agent's identity key (`agent.key`) is **encrypted at rest** with a software
machine-bound key (HKDF over `/etc/machine-id` + a per-install salt in
`/etc/nexus/agent-keysalt`, AES-256-GCM). This protects against a **stray copy of
the key file alone** (without the machine context) and against **reuse on another
machine**.

> ⚠️ **It does NOT protect a full disk image / VM snapshot / whole-filesystem backup
> (e.g. Proxmox snapshots, PBS backups).** The `machine-id` and the salt travel
> *with* the disk, so an attacker holding a complete image can re-derive the
> wrapping key and decrypt `agent.key`. Treat full snapshots/backups of an agent
> host as containing its identity. Closing this case requires **TPM 2.0 sealing**
> (planned, opt-in for hosts that have a usable TPM) — it is **not** provided by the
> software path. A live root (or `nexus-agent`-user) compromise can likewise
> re-derive the key; the blanket-file-read capability that would bypass file
> permissions has been dropped from the agent unit.

## Quick start

### Server (Docker Compose)

```bash
cp .env.example .env
# Edit .env: set JWT_SECRET, ECDSA_MASTER_SECRET, Postgres creds
docker compose up -d
```

Access at `http://localhost:26032` (or your configured port).

> ⚠️ **Bootstrap order (mandatory).** The agent binary is **not** baked into the backend
> image — it is served from a `release/` volume populated **only by a signed release**
> (release signing: see [OPERATOR-KEYS.md](OPERATOR-KEYS.md)). Until you publish the first signed release,
> `/api/agents/download` returns `500 "binary not available"` — so you can **neither
> install a new agent nor upgrade one**. Already-enrolled agents are unaffected (each runs
> its own locally-installed binary). Correct order: **deploy the backend → publish the
> first signed release → then install agents.**

### Enroll an agent

1. Go to **Machines → Add a machine**
2. Copy the install command provided
3. Run on the target host as root

```bash
sudo bash install-agent.sh \
  --server-url wss://nexus.example.com/ws/agent \
  --machine-id <id> \
  --enrollment-token <token> \
  --server-public-key <pem>
```

The agent registers via ECDSA handshake, derives a shared AES-256-GCM secret, and starts sending heartbeats.

### Self-monitoring

Install the agent on the Nexus server itself to monitor the host. **Mark the machine as `isCritical`** to prevent accidental self-destruction (reboot, docker stop, etc.).

See in-app docs: `/docs?section=self`

## Project structure

```
nexus/
├── backend/           # Fastify API + WebSocket server
│   ├── src/
│   │   ├── routes/    # 18 route files (machines, alerts, bulk, firewall, ...)
│   │   ├── services/  # alert-engine, action-dispatcher, crypto, ...
│   │   └── websocket/ # agent + dashboard channels
│   └── prisma/        # Schema + migrations
├── agent/             # Go agent
│   └── internal/
│       ├── actions/   # 30 action files (services, firewall, netplan, ssl, ...)
│       ├── security/  # keystore, sandbox, crypto
│       └── transport/ # WebSocket client
├── frontend/          # React SPA
│   └── src/
│       ├── pages/     # 12 pages (Dashboard, Machines, Alerts, Docs, ...)
│       └── components/# 20+ components (per-tab, dialogs, cards)
├── scripts/
│   └── install-agent.sh  # One-shot install script (user + systemd + sudoers)
└── docker-compose.yml
```

## Development

```bash
# Backend
cd backend && npm install && npx prisma migrate dev && npm run dev

# Frontend
cd frontend && npm install && npm run dev

# Agent
cd agent && go build ./cmd/nexus-agent && ./nexus-agent --config ./config.yml

# Tests
cd backend && npm run test   # 317 tests (vitest, file-presence + patterns)
cd agent && go vet ./...
cd frontend && npx tsc --noEmit
```

## Documentation

In-app documentation at `/docs` covers:
- Getting started
- Agent installation
- Self-monitoring (agent on Nexus server)
- Machines management
- Tags & groups
- Profiles
- Alerts & notifications
- System updates + package pinning
- SSH configuration (macOS/Linux/Windows WSL)
- Security
- API reference

## Validation

Manually validated on real VMs (Ubuntu 22.04/24.04, Debian 12).

## Security

Nexus administers servers as root; its trust model is documented explicitly:

- **[THREAT-MODEL.md](THREAT-MODEL.md)** — what is protected (trust root, agent
  confinement, web boundary) and, just as important, the **assumed limits**
  (full-disk snapshot, no tenant isolation, SSRF blocking private ranges by
  default). Read it before changing anything security-related.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability (private
  channel — **never a public issue**), scope, supported versions, and
  coordinated disclosure.

See also the "Authorization model" and "Agent key at rest" notes above.

## Supply chain & agent integrity

Nexus upgrades its own agents in place, so the integrity of the agent binary is
part of the trust model. The trust root for upgrades is an **offline signing key
held by the operator — not the backend**.

1. **Reproducible build** — the agent is a static Go binary (`CGO_ENABLED=0`,
   `-trimpath`, Go toolchain pinned by digest), so it rebuilds **byte-for-byte**:
   anyone can recompile from source and get the same `sha256` that was signed.
2. **Offline signing (human approval)** — each release is signed with a
   [minisign](https://jedisct1.github.io/minisign/) (Ed25519) key that never
   leaves an offline machine; a human reviews the version and `sha256` before
   signing. The signature is a detached `.minisig` published next to the binary.
3. **Backend only relays** — the backend serves the binary and its signature but
   never holds the private key, so **a compromised backend cannot push a trojaned
   binary**.
4. **Agent verifies, fail-closed** — before replacing itself the agent verifies the
   minisign signature against a local accept-list (`/etc/nexus/release.pub`), and
   enforces the sha256, an anti-rollback version floor, download-origin pinning and
   anti-TOCTOU re-checks. No local release key ⇒ every upgrade is refused.

Two trust models are supported: **trust the project's signed release** (like a
signed apt package — verifiable via the reproducible build) or **bring your own
release key** so the upgrade trust root is yours alone (recommended for isolated
deployments). Key management — and how to reproduce and verify a release build —
is documented in [OPERATOR-KEYS.md](OPERATOR-KEYS.md).

## Development & AI assistance

Nexus was built with the assistance of AI tools (Anthropic's Claude). The
architecture, security model, threat model, code review, testing and
real-VM validation were directed by — and remain the responsibility of —
the maintainer, Jean-Sébastien Loiseau. AI accelerated the work; it did
not replace the engineering judgment, review, and hands-on validation
behind it.

The full, granular development trail is in the git history.

## License

Nexus is distributed under the **GNU Affero General Public License v3.0
(AGPL-3.0)** — see [LICENSE](LICENSE).

The AGPL is a strong **network copyleft** license: if you run a modified version
of Nexus and make it available to others over a network (as a service), you must
offer those users the corresponding modified source under the same license.

Contributions are accepted under a Contributor License Agreement — see
[CLA.md](CLA.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Opening a pull request
implies acceptance of the CLA.
