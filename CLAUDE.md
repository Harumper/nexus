# CLAUDE.md

Context for AI assistants working on this codebase. Human contributors should read `README.md` first.

## Architecture invariants

- **Capability model was REMOVED** (commit `f651d5f`). Access control is now based on `Machine.type` (PROBE=read-only, AGENT=full). Do NOT re-introduce `Capability`/`MachineCapability` tables. If you find references to `capabilities[]` in old code or docs, they're bugs.
- **Actions Go have a `Capability() string` method** — this is a metadata label for logging, NOT a runtime check. Don't wire it to any access control.
- **PROBE allow-list** lives in two places that must stay in sync:
  - `backend/src/services/machine-manager.ts` → `PROBE_ALLOWED_ACTIONS`
  - `agent/cmd/nexus-agent/main.go` → `probeAllowedActions`
  When adding a read-only action, update both.

## Watchdog-revert pattern

Firewall (`60s`) and netplan (`120s`) use the same pattern:

1. Agent takes a snapshot to `/var/lib/nexus-agent/{firewall|netplan}-snapshot-<reqid>.{iptables|}/`
2. Applies the mutation
3. Arms `time.AfterFunc` to revert if not confirmed
4. Backend `POST /api/machines/:id/{firewall|netplan}/confirm` sends `action.confirm` signed WS message
5. Agent cancels the timer + deletes the snapshot
6. **Dead-man's switch**: on agent boot, `RecoverPendingSnapshots()` / `RecoverPendingNetplan()` scans snapshot dir and reverts anything left (covers agent crash during the window)

When adding a new watchdog action, follow this exact pattern. Don't invent variants.

## Security rules

- **Sudoers**: every `exec.Command("sudo", ...)` or `exec.Command("/usr/bin/sudo", ...)` in agent code must have a matching line in `scripts/install-agent.sh`. Use fixed paths (no PATH lookup), escape wildcards carefully. Audit tests enforce this.
- **No shell interpolation**: never `sh -c "... $userInput ..."`. Pass args as slices to `exec.Command`. When writing files with user content, use tempfiles + `sudo install` (see `users.go` sshkey add/remove).
- **Validation regexes**: POSIX login names `^[a-z_][a-z0-9_-]{0,31}$`, service names `^[a-zA-Z0-9@_.\-]+(\.service)?$`, package names `^[a-z0-9][a-z0-9+.\-]*$`. Reuse constants, don't re-declare.
- **isCritical flag** blocks `system.reboot`, stop/restart of critical services (docker/nginx/ssh/postgres/...), and remove of critical packages. See `backend/src/services/machine-protection.ts`.
- **nexus-agent service protection**: hardcoded in `agent/internal/actions/services.go` — cannot be stopped/restarted by itself.

## Coding conventions

- **Go actions**: one file per feature group (`firewall.go`, `users.go`). Each action = struct with `ID()/Capability()/Validate()/Execute()` methods. Register in `init()`.
- **Prisma migrations**: never use `prisma db push --accept-data-loss` in production CI — it breaks `GENERATED` columns (tsvector). Use `prisma migrate deploy`.
- **Frontend components**: one file per tab in `frontend/src/components/*Tab.tsx`. CSS variables (`var(--nx-*)`) for colors, not Tailwind color classes directly. Check existing tabs for patterns.
- **API helpers**: all in `frontend/src/services/api.ts`. Group by feature (firewall, network, etc.).
- **Tests**: `backend/tests/e2e/*.test.ts` use Vitest with file-presence + content-pattern assertions. They don't actually execute actions — they verify structural cohesion. 197 tests currently. Add tests when adding new features.

## Common pitfalls

- **TypeScript enum extensions**: when adding `AlertConditionType` values in schema.prisma, you also need a migration with `ALTER TYPE ... ADD VALUE 'X'` (not a full column change).
- **Prisma types after schema change**: run `npx prisma generate` in `backend/`, then `npx tsc --noEmit` to surface type errors in routes/services.
- **Agent rebuild required** for Go code changes. The CI builds and embeds the binary via `agent-download` route. Local dev: `CGO_ENABLED=0 go build -o /tmp/nexus-agent ./cmd/nexus-agent`.
- **Agent versioning** is semver driven by git tags. `main.Version` defaults to `"dev"` and is injected at build via `-ldflags "-X main.Version=$AGENT_VERSION"`. The CI `version` job runs `git describe --tags` and propagates `AGENT_VERSION` (dotenv) to the backend/agent image builds. **To release: `git tag vX.Y.Z && git push origin vX.Y.Z`** → tag pipeline builds images stamped `X.Y.Z`. Untagged master builds get `X.Y.Z-N-g<sha>`. The agent reports this version in its heartbeat (`agent_version`); upgrade completion is detected by **binary SHA match**, not the version string, so it's robust even if the version is unchanged.
- **PROBE and AGENT machines**: check `isActionAllowed(machineId, actionId)` in `action-dispatcher.ts`. If PROBE tries a mutation, the dispatcher returns an error *before* sending to agent.
- **Bulk dispatch** (`/api/bulk/dispatch`) has its own `BULK_ALLOWED_ACTIONS` whitelist. Netplan/firewall excluded because they need individual confirmation.

## Alerting

- `evaluateMetrics()` — on each heartbeat (fast)
- `evaluateOfflineAlerts()` — every 60s
- `evaluateHealthAlerts()` — every 5 min (polls `system.health_summary` on each AGENT)
- `evaluateCertAlerts()` — every 6h (polls `ssl.scan`)

When adding a new alert condition type, update:
1. `prisma/schema.prisma` enum + migration (`ALTER TYPE ... ADD VALUE`)
2. `alert-engine.ts` — either `checkCondition()` (metrics) or a new evaluator (if it needs agent poll)
3. `alerts.ts` route — schema validation
4. `Alerts.tsx` — select options + threshold/targetPattern UI
5. `Docs.tsx` AlertsDoc

## What NOT to do

- Don't add terminal/VNC/Guacamole integration — user chose the `ssh://` + clipboard approach (commit `896fd76`). The docs page explains OS-specific setup.
- Don't add Docker management — user has Nautilus for that.
- Don't re-introduce capabilities.
- Don't add `nexus-agent` user to dangerous groups beyond `systemd-journal` (for log reading).

## Tier references

- **Tier 0** (shipped): reboot, services, journalctl, firewall+watchdog, apt search FTS
- **Tier 1** (shipped): storage LVM, cron/timers, users+SSH keys, netplan+watchdog
- **Phase B** (shipped): package hold, bulk actions, SSL tracking, extended alerting, self-monitoring docs, isCritical
- **Future**: Phase A real-VM e2e tests, compliance Lynis (only if user has fleet >5 machines), CMD+K palette
