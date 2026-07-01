# Changelog

All notable changes to Nexus are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are driven by git tags (`vX.Y.Z`); the agent binary is built
reproducibly and signed offline — see [OPERATOR-KEYS.md](OPERATOR-KEYS.md) and
the "Supply chain & agent integrity" section of the README.

## [Unreleased]

Baseline for the first public release. Highlights of the current feature set:

### Monitoring
- Metrics (CPU, RAM, disk, load, network) with historical charts
- Processes, storage (LVM), systemd services and timers, cron jobs
- SSL certificate scanning

### Administration
- System updates (apt) with live progress, package install/remove/hold
- Service control, journalctl viewer, user + SSH key management
- Firewall (ufw) and netplan editing, both with watchdog-revert
- Reboot and signed agent self-upgrade

### Fleet operations
- Bulk actions, tags, static/dynamic groups, scheduled profiles

### Alerting
- Metric, connectivity, health, and security conditions
- HMAC-signed webhooks, SMTP email, and real-time WebSocket notifications

### Security
- ECDSA P-256 + AES-256-GCM over WebSocket, mandatory server-key pinning
- RBAC (ADMIN / OPERATOR / READONLY), critical-machine protection
- Offline-signed, reproducible agent binaries with fail-closed verification

[Unreleased]: https://github.com/
