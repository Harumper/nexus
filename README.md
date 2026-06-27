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
- **Machine types**: PROBE (read-only monitoring) / AGENT (full access)
- **Critical flag** (`isCritical`): blocks `reboot`, `service_stop/restart` on critical services (docker/nginx/ssh/postgres), `package.remove` on critical packages
- **Watchdog-revert**: snapshot before mutation + 60s/120s timer + dead-man's switch at agent boot
- Sudoers whitelist (no wildcards on dangerous commands, NOEXEC where relevant)
- Systemd hardening: `StateDirectory`, `Protect*`, no ambient capabilities

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

### Enroll an agent

1. Go to **Machines → Add a machine**, choose type (AGENT or PROBE)
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
│   │   ├── routes/    # 17 route files (machines, alerts, bulk, firewall, ...)
│   │   ├── services/  # alert-engine, action-dispatcher, crypto, ...
│   │   └── websocket/ # agent + dashboard channels
│   └── prisma/        # Schema + migrations
├── agent/             # Go agent
│   └── internal/
│       ├── actions/   # 23 action files (services, firewall, netplan, ssl, ...)
│       ├── security/  # keystore, sandbox, crypto
│       └── transport/ # WebSocket client
├── frontend/          # React SPA
│   └── src/
│       ├── pages/     # 13 pages (Dashboard, Machines, Alerts, Docs, ...)
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
cd backend && npm run test   # 197 tests (vitest, file-presence + patterns)
cd agent && go vet ./...
cd frontend && npx tsc --noEmit
```

## Documentation

In-app documentation at `/docs` covers:
- Getting started
- Agent installation
- Probe mode
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

See `VALIDATION_CHECKLIST.md` for manual validation on real VMs (Ubuntu 22.04/24.04, Debian 12).

## License

Private / internal project.
