#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Nexus Agent - Installation script
# ============================================
# Usage:
#   sudo ./install-agent.sh \
#     --server-url wss://nexus.example.com/ws/agent \
#     --machine-id <id> \
#     --enrollment-token <token>
#
# Or interactive:
#   sudo ./install-agent.sh
# ============================================

AGENT_USER="nexus-agent"
AGENT_GROUP="nexus-agent"
INSTALL_DIR="/opt/nexus"
BIN_PATH="/usr/local/bin/nexus-agent"
CONFIG_DIR="/etc/nexus"
KEY_DIR="/var/lib/nexus/keys"
LOG_DIR="/var/log/nexus"
SERVICE_NAME="nexus-agent"
AGENT_SCRIPT_DIR="/var/lib/nexus-agent"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ===================== Checks =====================

if [ "$EUID" -ne 0 ]; then
    error "This script must be run as root (sudo)."
    exit 1
fi

# ===================== Cleanup functions =====================

# wipe_agent: COMPLETE removal of the agent (clean slate) — service, binary,
# keys, shared secret, server key, config, state/snapshots, SUDOERS, user.
# Argument "keep-logs" → keeps $LOG_DIR (re-enrollment case), otherwise the
# logs are removed too (--uninstall case).
# Reused by do_uninstall AND by --reenroll: a re-enrollment thus starts from
# a clean base (sudoers/user/binary included), not just the identity.
wipe_agent() {
    local keep_logs="${1:-}"

    # 1. systemd service: stop + disable + remove unit + reload
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        systemctl stop "$SERVICE_NAME" && ok "Service stopped."
    fi
    systemctl disable "$SERVICE_NAME" &>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE_NAME" &>/dev/null || true
    ok "systemd unit removed."

    # 1b. Ensure NO agent process survives. Otherwise `userdel` fails
    # AND — worse — the old agent stays connected with the old identity
    # and conflicts with the new one during re-enrollment (ECDSA check
    # failure / stolen WS session). We terminate cleanly then force.
    if id "$AGENT_USER" &>/dev/null; then
        pkill -TERM -u "$AGENT_USER" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            pgrep -u "$AGENT_USER" >/dev/null 2>&1 || break
            sleep 1
        done
        pkill -KILL -u "$AGENT_USER" 2>/dev/null || true
    fi

    # 2. Binary
    rm -f "$BIN_PATH"
    ok "Binary removed: $BIN_PATH"

    # 3. Keys, shared secret, server key, config, state/snapshots (+ logs if not kept)
    rm -rf "$KEY_DIR" /opt/nexus/keys /var/lib/nexus /opt/nexus
    rm -rf "$CONFIG_DIR"
    rm -rf "$AGENT_SCRIPT_DIR"        # /var/lib/nexus-agent (snapshots/inbox/scripts/tempfiles)
    if [ "$keep_logs" = "keep-logs" ]; then
        ok "Keys, config, state and snapshots removed (logs kept)."
    else
        rm -rf "$LOG_DIR"
        ok "Keys, config, state, snapshots and logs removed."
    fi

    # 4. Sudoers (clean slate — rewritten afterward by the install)
    rm -f /etc/sudoers.d/nexus-agent
    ok "Sudoers removed."

    # 5. System user + removal from the group
    if id "$AGENT_USER" &>/dev/null; then
        gpasswd -d "$AGENT_USER" systemd-journal &>/dev/null || true
        userdel "$AGENT_USER" &>/dev/null && ok "User '$AGENT_USER' removed." || \
            warn "Could not remove user '$AGENT_USER' (process still running?)."
    fi
}

# do_uninstall: complete removal (--purge), logs included.
do_uninstall() {
    echo ""
    echo -e "${BLUE}=== Nexus Agent - Full uninstall ===${NC}"
    echo ""
    wipe_agent
    echo ""
    echo -e "${GREEN}=== Uninstall complete ===${NC}"
    echo "The /etc/sudoers.bak.* backups are left untouched (remove manually if needed)."
    echo ""
}

# ===================== Parameters =====================

SERVER_URL=""
MACHINE_ID=""
ENROLLMENT_TOKEN=""
SERVER_PUBLIC_KEY=""
RELEASE_PUBKEY=""
SCRIPT_SIGNING_PUBKEY=""
ALLOW_REMOTE_SCRIPT="false"   # opt-in: emits the bash nexus-script sudoers line
INSECURE="false"             # dev opt-in: allows a non-wss:// server-url (NEXUS_ALLOW_INSECURE)
AGENT_BINARY=""
HEARTBEAT_INTERVAL=30
METRICS_INTERVAL=60
MODE="install"          # install | uninstall | reenroll

while [[ $# -gt 0 ]]; do
    case $1 in
        --server-url)       SERVER_URL="$2";        shift 2 ;;
        --machine-id)       MACHINE_ID="$2";        shift 2 ;;
        --enrollment-token) ENROLLMENT_TOKEN="$2";  shift 2 ;;
        --server-public-key) SERVER_PUBLIC_KEY="$2"; shift 2 ;;
        --server-public-key-file)
            if [ ! -f "$2" ]; then
                error "Public key file not found: $2"
                exit 1
            fi
            SERVER_PUBLIC_KEY="$(cat "$2")"
            shift 2 ;;
        --release-pubkey-file)
            # minisign accept-list of release public keys (auto-upgrade).
            # Key(s) generated offline by the operator; only the public
            # half is placed here. Without this file, the agent refuses any
            # auto-update (fail-closed).
            if [ ! -f "$2" ]; then
                error "Release public key file not found: $2"
                exit 1
            fi
            RELEASE_PUBKEY="$(cat "$2")"
            shift 2 ;;
        --script-signing-pubkey-file)
            # minisign accept-list DEDICATED to script signing (distinct from
            # the server key and the release key). Private offline on the
            # operator side; only the public half is placed here.
            if [ ! -f "$2" ]; then
                error "Script signing public key file not found: $2"
                exit 1
            fi
            SCRIPT_SIGNING_PUBKEY="$(cat "$2")"
            shift 2 ;;
        --allow-remote-script)
            # EXPLICIT opt-in: without this flag, the sudoers line allowing
            # `sudo /bin/bash nexus-script-*.sh` is NOT written → the root-RCE
            # capability does not exist on the system (not just a refused flag).
            ALLOW_REMOTE_SCRIPT="true"; shift ;;
        --insecure)
            # DEV opt-in only: allows a non-wss:// --server-url and sets
            # NEXUS_ALLOW_INSECURE=1 (the agent then logs a WARNING on every boot).
            INSECURE="true"; shift ;;
        --binary)           AGENT_BINARY="$2";      shift 2 ;;
        --heartbeat)        HEARTBEAT_INTERVAL="$2"; shift 2 ;;
        --metrics)          METRICS_INTERVAL="$2";  shift 2 ;;
        --uninstall|--purge) MODE="uninstall";      shift ;;
        # --reenroll: CLEAN SLATE (removes binary, keys, secret, config,
        # state, sudoers, user; keeps the logs) THEN a clean reinstall.
        --reenroll)         MODE="reenroll";        shift ;;
        -h|--help)
            echo "Usage:"
            echo "  install-agent.sh --server-url URL --machine-id ID --enrollment-token TOKEN [--server-public-key-file F] [--release-pubkey-file F]"
            echo "       --release-pubkey-file F : minisign release public key(s) → /etc/nexus/release.pub (signed auto-upgrade; without it, auto-upgrade is refused)"
            echo "       --script-signing-pubkey-file F : minisign script signing public key(s) → /etc/nexus/script-signing.pub"
            echo "       --allow-remote-script : emit the sudoers line allowing script.execute (OFF by default; root-RCE capability absent otherwise)"
            echo "       --insecure : allow a non-wss:// --server-url (NEXUS_ALLOW_INSECURE=1; WARNING on every boot) — LOCAL DEV only"
            echo "  install-agent.sh --server-url URL --machine-id ID                                              # REFRESH sudoers+service (agent already enrolled)"
            echo "  install-agent.sh --reenroll  --server-url URL --machine-id ID --enrollment-token TOKEN [...]   # CLEAN WIPE (sudoers/user/binary, logs kept) + reinstall"
            echo "  install-agent.sh --uninstall                                                                   # full removal"
            echo ""
            echo "  NB: the 'self-upgrade' update (from the UI) replaces ONLY the binary."
            echo "      sudoers and systemd service are (re)written only by this script —"
            echo "      re-run it if the sudoers has drifted (e.g. a new whitelisted command)."
            exit 0 ;;
        *) error "Unknown option: $1"; exit 1 ;;
    esac
done

# Uninstall mode: enrollment params not needed
if [ "$MODE" = "uninstall" ]; then
    do_uninstall
    exit 0
fi

# Interactive mode if the params are missing
if [ -z "$SERVER_URL" ]; then
    echo ""
    echo -e "${BLUE}=== Nexus Agent - Installation ===${NC}"
    echo ""
    read -p "Nexus server URL (e.g. ws://nexus:26031/ws/agent): " SERVER_URL
fi

if [ -z "$MACHINE_ID" ]; then
    read -p "Machine ID: " MACHINE_ID
fi

# The token is required ONLY if the agent does not already have an ENROLLED local identity.
# v2 marker = "enrolled" file (cf. agent keystore.go MarkEnrolled/IsEnrolled: it is
# what makes enrollment be skipped at boot); we also test agent.key for robustness
# (residual identity even if the marker is missing). ⚠ DO NOT test shared.secret: it is
# a v1 vestige, NO LONGER written in v2 (the channel key is derived by the ECDHE handshake, never
# persisted) → using it made this detection ALWAYS false. For a simple
# sudoers/binary refresh on an already-enrolled machine, the agent reuses its
# existing keys and does not re-enroll.
HAS_LOCAL_IDENTITY=false
if { [ -f "$KEY_DIR/enrolled" ] || [ -f "$KEY_DIR/agent.key" ]; } && [ "$MODE" != "reenroll" ]; then
    HAS_LOCAL_IDENTITY=true
fi

# Anti-deadlock safeguard (explicit refusal, never an auto-purge): an --enrollment-token
# supplied while a local identity ALREADY exists is a trap. The agent skips enrollment
# as long as the "enrolled" marker is present → it IGNORES the token and keeps its old
# identity; if that identity was invalidated server-side (machine deleted/recreated/re-enrolled),
# the boot loops on "Session handshake failed: unexpected handshake response type: error".
# We refuse rather than boot into a wall. Identity purge is DESTRUCTIVE: it is
# never automatic, it requires the deliberate --reenroll gesture (which the UI
# "Re-enroll" button already adds). We do NOT compare the machine-id: "token + identity"
# is enough, and a refusal is non-destructive (no exploitable purge primitive).
if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -n "$ENROLLMENT_TOKEN" ]; then
    error "A Nexus identity is already present on this host (marker: $KEY_DIR/enrolled) AND an --enrollment-token was supplied."
    error "The agent would IGNORE this token and keep its existing identity. If that identity was revoked server-side (machine deleted/recreated/re-enrolled), the agent loops on 'Session handshake failed: unexpected handshake response type: error'."
    error "Choose one:"
    error "  - Re-enroll cleanly (WIPE the local identity, then enroll with this token):"
    error "      re-run ONLY this install step with --reenroll appended -- do NOT re-run the download steps (1 and 2)."
    error "      The binary and install script are already downloaded; the download and install-script tokens are single-use and already spent, while the enrollment token is still valid."
    error "      (The UI 'Re-enroll' button adds --reenroll automatically.)"
    error "  - Only refresh sudoers/binary (KEEP the current identity):"
    error "      re-run WITHOUT --enrollment-token."
    error "Refusal is deliberate: wiping the identity is destructive and is never done automatically."
    exit 1
fi

if [ -z "$ENROLLMENT_TOKEN" ] && [ "$HAS_LOCAL_IDENTITY" = false ]; then
    read -p "Enrollment token: " ENROLLMENT_TOKEN
fi

if [ -z "$SERVER_URL" ] || [ -z "$MACHINE_ID" ]; then
    error "server-url and machine-id are required."
    exit 1
fi

# NEXUS-ENROLLMENT-001 — wss:// guard at install time (mirror of the agent
# guard), to fail here rather than silently at runtime. A cleartext --server-url
# (ws://, http://) is only accepted with --insecure (local dev).
case "$SERVER_URL" in
    wss://*) ;;
    *)
        if [ "$INSECURE" != "true" ]; then
            error "--server-url must use wss:// (TLS mandatory for bootstrap): '$SERVER_URL'."
            error "The token and the agent public key would travel in clear text. Use wss://, or --insecure for local dev only."
            exit 1
        fi
        warn "UNENCRYPTED transport accepted (--insecure): '$SERVER_URL'. NEXUS_ALLOW_INSECURE=1 will be set; the agent logs a WARNING on every boot. Local dev only."
        ;;
esac

if [ -z "$ENROLLMENT_TOKEN" ] && [ "$HAS_LOCAL_IDENTITY" = false ]; then
    error "enrollment-token required (no local identity in $KEY_DIR). Use --reenroll to start from scratch."
    exit 1
fi

if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -z "$ENROLLMENT_TOKEN" ]; then
    info "Local identity detected: refreshing (sudoers/binary) without re-enrollment."
    ENROLLMENT_TOKEN="__refresh__"   # placeholder, unused (the agent skips enrollment)
fi

# STRICT PINNING: the server public key is mandatory for a (re-)enrollment.
# On refresh (local identity present), the existing key in $CONFIG_DIR is kept.
if [ "$HAS_LOCAL_IDENTITY" = false ] && [ -z "${SERVER_PUBLIC_KEY:-}" ]; then
    error "--server-public-key-file required: the server key is mandatory (isolation pinning)."
    error "Use the install command generated by the Nexus UI (it includes the key)."
    exit 1
fi

echo ""
info "Configuration:"
echo "  Server URL    : $SERVER_URL"
echo "  Machine ID    : $MACHINE_ID"
echo "  Token         : ${ENROLLMENT_TOKEN:0:20}..."
echo ""

# ===================== 0. Stop the agent if it is already running (re-install) =====================

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Agent currently running, stopping before reinstall..."
    systemctl stop "$SERVICE_NAME"
    ok "Agent stopped."
fi

# Re-enrollment: CLEAN SLATE before reinstalling (sudoers/user/binary included,
# logs kept). Avoids both the shared.secret deadlock AND the stale
# sudoers (since everything is rewritten afterward by the install).
if [ "$MODE" = "reenroll" ]; then
    info "Re-enrollment: full agent purge (clean wipe, logs kept)…"
    wipe_agent keep-logs
fi

# ===================== 1. Create the system user =====================

info "Creating system user '$AGENT_USER'..."

if id "$AGENT_USER" &>/dev/null; then
    ok "User '$AGENT_USER' already exists."
else
    useradd \
        --system \
        --no-create-home \
        --home-dir "$INSTALL_DIR" \
        --shell /usr/sbin/nologin \
        --comment "Nexus Agent" \
        "$AGENT_USER"
    ok "User '$AGENT_USER' created."
fi

# Add to the systemd-journal group to read logs via journalctl
# (avoids having to whitelist journalctl in sudoers)
if getent group systemd-journal > /dev/null; then
    usermod -a -G systemd-journal "$AGENT_USER"
    ok "Added to the systemd-journal group for log reading."
fi

# ===================== 2. Configure sudoers (privileged commands) =====================

info "Configuring sudo privileges for '$AGENT_USER'..."

SUDOERS_FILE="/etc/sudoers.d/nexus-agent"

# Note: we NEVER modify /etc/sudoers (only the /etc/sudoers.d/nexus-agent
# drop-in), so no backup of /etc/sudoers — this avoided
# the accumulation of /etc/sudoers.bak.* on every reinstall.

# Create the dedicated directory for agent scripts (not world-writable /tmp)
mkdir -p "$AGENT_SCRIPT_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$AGENT_SCRIPT_DIR"
chmod 0700 "$AGENT_SCRIPT_DIR"

# Inbox for uploads via fs.upload (file browser). Owner agent, 0750:
# the end user will use SSH + sudo to move files elsewhere. The
# files are written 0640 and auto-removed after 7 days by the agent.
mkdir -p "$AGENT_SCRIPT_DIR/inbox"
chown "$AGENT_USER":"$AGENT_GROUP" "$AGENT_SCRIPT_DIR/inbox"
chmod 0750 "$AGENT_SCRIPT_DIR/inbox"

# Create the sudoers file in a secure temp
SUDOERS_TEMP=$(mktemp -t nexus-agent-sudoers.XXXXXX)
trap "rm -f '$SUDOERS_TEMP'" EXIT

cat > "$SUDOERS_TEMP" << 'SUDOERS'
# Nexus Agent - Sudoers
# Commands allowed for the Nexus agent (without a password)
# Generated by install-agent.sh — DO NOT EDIT MANUALLY

# === NEXUS-AGENT-009: environment posture pinned for this drop-in ===
# The agent's confinement must NOT depend on an invariant held in
# /etc/sudoers (which an operator may legitimately customize). So we scope
# env_reset + secure_path to nexus-agent here. No dangerous env_keep
# (LD_PRELOAD/BASH_ENV/ENV) is ever added — an injected .so or a BASH_ENV
# sourced as root via `sudo /bin/bash nexus-script-*.sh` would stay blocked even if
# the global /etc/sudoers were weakened.
Defaults:nexus-agent env_reset
Defaults:nexus-agent secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# === Package management (APT) ===
# === Self-introspection (read sudoers to detect drift) ===
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/sudoers.d/nexus-agent

# === APT ===
# NEXUS-AGENT-010 — SCOPE of NOEXEC (do not over-interpret): NOEXEC is
# NOT a pillar of general confinement. It applies ONLY to the
# install/remove lines of the package managers (apt-get/dnf/yum, ~6 lines), as
# a targeted BACKSTOP for the package-name wildcard: it prevents a package/hook
# from triggering the execution of an arbitrary subprocess (like `-o
# DPkg::Pre-Invoke=`). The ~44 other lines do NOT rely on NOEXEC but on
# fixed paths, EXACT arguments, the compiled privhelper, and the Go-side
# validation regexes. NOEXEC is a net over a single primitive, not the overall
# guarantee.
# upgrade/update: EXACT arguments (no wildcard) — otherwise `-o
# DPkg::Pre-Invoke=...` would allow the execution of arbitrary root commands.
# install/remove keep a wildcard (package names, validated in Go by
# packageNameRegex) + NOEXEC.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-get update
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade -y -q
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/apt-get install -y -qq *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/apt-get remove -y -qq *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/unattended-upgrades --minimal_upgrade_steps

# === Package management (DNF/YUM) === (exact arguments, see system_update.go)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf update --security -y -q
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf update -y -q
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf upgrade -y -q
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/dnf install -y -q *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/dnf remove -y -q *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/yum update --security -y -q
nexus-agent ALL=(root) NOPASSWD: /usr/bin/yum update -y -q
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/yum install -y -q *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/yum remove -y -q *

# === Processes (explicit signals only) ===
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGTERM [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGKILL [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGHUP [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGINT [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGUSR1 [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGUSR2 [0-9]*

# === Compiled privhelper (NEXUS-AGENT-003/008: root wrapper of the agent binary) ===
# The agent binary, invoked as `privhelper <op>`, runs as root privileged
# operations STRICTLY validated in Go (user creation with `--`, writes with
# realpath + literal dest) — replaces the old exploitable `useradd *` /
# `install … */…*` lines. No shell/interpreter invocable (binary
# compiled root:root 0755). The `*` here applies to the args, validated by the binary.
nexus-agent ALL=(root) NOPASSWD: /usr/local/bin/nexus-agent privhelper *

# === Script execution: rule deliberately ABSENT from this static heredoc ===
# The script execution rule is only emitted as opt-in (--allow-remote-script),
# appended outside this block just before `visudo`. When off, the corresponding
# root-RCE capability exists nowhere in this file.

# === Reboot ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl reboot

# === systemd services (start/stop/restart/reload/enable/disable) ===
# NEXUS-AGENT-006 — no more raw `systemctl <verb> *` in sudoers (the
# `systemctl stop ssh*` blocklist was bypassed by inserting an option:
# `systemctl stop --no-ask-password ssh` matched `stop *` but not the negation).
# All service control goes through the compiled privhelper (already allowed
# above: `nexus-agent privhelper *`), which canonicalizes verb+unit and refuses in
# code the injected options and the protected units (ssh/sshd/nexus-agent). The
# protection therefore no longer depends on an option-sensitive sudoers pattern.

# === Hardening remediations (Phase 2 — writing configs) ===
# fail2ban (anti-bruteforce) and unattended-upgrades (auto updates). Fixed destinations.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-fail2ban-*.tmp /etc/fail2ban/jail.local
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-autoupd-*.tmp /etc/apt/apt.conf.d/20auto-upgrades
# Legal banner (security.set_login_banner): /etc/issue + /etc/issue.net
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-banner-*.tmp /etc/issue
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-banner-*.tmp /etc/issue.net
# Core dumps off (security.disable_core_dumps)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-nocore-*.tmp /etc/security/limits.d/99-nexus-nocore.conf
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-coredump-*.tmp /etc/sysctl.d/99-nexus-coredump.conf
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/sysctl -p /etc/sysctl.d/99-nexus-coredump.conf
# login.defs hardening (security.harden_login_defs)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-logindefs-*.tmp /etc/login.defs
# Network/kernel sysctl hardening (security.harden_sysctl_network); -e ignores unknown keys (IPv6 off)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-netsysctl-*.tmp /etc/sysctl.d/99-nexus-network.conf
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/sysctl -e -p /etc/sysctl.d/99-nexus-network.conf

# === Log shipping (logs.configure_shipping / logs.disable_shipping): Fluent Bit ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-flbconf-*.tmp /etc/fluent-bit/nexus.yaml
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -D -m 644 -o root -g root /var/lib/nexus-agent/sec-flbdropin-*.tmp /etc/systemd/system/fluent-bit.service.d/10-nexus.conf
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload
nexus-agent ALL=(root) NOPASSWD: /bin/rm -f /etc/systemd/system/fluent-bit.service.d/10-nexus.conf
nexus-agent ALL=(root) NOPASSWD: /bin/rm -f /etc/fluent-bit/nexus.yaml

# === Firewall assistant: listening sockets (read-only) ===
# ss -p (process names) requires root. Paths depend on packaging (sbin/bin).
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ss -Htlnp
nexus-agent ALL=(root) NOPASSWD: /usr/bin/ss -Htlnp

# === SSH hardening (drop-in + watchdog-revert) ===
# Nexus drop-in only (99-nexus-hardening.conf); sshd -t validates BEFORE reload.
# The reload is done via SIGHUP (kill, already whitelisted) — `systemctl reload ssh`
# stays BLOCKED to avoid lock-out. /bin/cat reads the drop-in for the snapshot.
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/sshd -t
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/ssh/sshd_config.d/99-nexus-hardening.conf
# NEXUS-AGENT-008: writing the sshd drop-in goes through `privhelper install-sshd`
# (realpath-validated source under /var/lib/nexus-agent/, FIXED dest) — the
# `install … /var/lib/nexus-agent/* …` line with a wildcard source is removed.
nexus-agent ALL=(root) NOPASSWD: /bin/rm -f /etc/ssh/sshd_config.d/99-nexus-hardening.conf

# === Firewall ufw + iptables (for watchdog snapshot/restore) ===
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw status *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw status
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw allow *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw deny *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw --force delete [0-9]*
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw --force enable
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw disable
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/iptables-save
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/iptables-restore

# === Self-upgrade (replacing the agent binary) ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 755 /var/lib/nexus-agent/nexus-agent.new /usr/local/bin/nexus-agent
# SELF-UPGRADE-005 (watchdog-revert): snapshot the current binary to .prev before
# overwriting, and restore .prev → binary if the upgrade does not confirm. FIXED
# paths on both sides.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 755 /usr/local/bin/nexus-agent /var/lib/nexus-agent/nexus-agent.prev
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 755 /var/lib/nexus-agent/nexus-agent.prev /usr/local/bin/nexus-agent

# === LVM report (storage overview) ===
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/pvs --reportformat json --units b --nosuffix -o *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/vgs --reportformat json --units b --nosuffix -o *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/lvs --reportformat json --units b --nosuffix -o *

# === SSL cert scanning (NEXUS-AGENT-001: PINNED predicate, no open tail) ===
# FROZEN roots + -maxdepth/-type/-name, WITHOUT a trailing ` *` → -exec/-fprintf/-execdir
# not appendable (no more GTFOBins find -exec root-shell). Must stay byte-identical
# to the args built by ssl_scan.go listCandidateCertFiles. /etc/ssl/private REMOVED
# (private keys). No parens (sudoers does not parse them): find precedence
# (-type f -name *.pem) OR (-type f -name *.crt), -maxdepth global.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/find /etc/letsencrypt/live /etc/ssl/certs/ssl-cert-snakeoil.pem /etc/nginx/ssl /etc/apache2/ssl /etc/haproxy/certs -maxdepth 4 -type f -name *.pem -o -type f -name *.crt
# CERTIFICATES only — NEVER the private keys. We exclude privkey.pem
# (Let's Encrypt), all of /etc/ssl/private (a key directory by definition) and
# the too-broad globs (/etc/nginx/ssl/* would read the .key files). ssl.scan only
# parses certificates; a refused cat is ignored cleanly.
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/letsencrypt/live/*/fullchain.pem
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/letsencrypt/live/*/cert.pem
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/letsencrypt/live/*/chain.pem
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/nginx/ssl/*.crt
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/apache2/ssl/*.crt
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/haproxy/certs/*.crt

# === Security audit (Lynis — read-only) ===
# audit system --quick --no-colors: non-interactive audit, streamed output (no
# system modification). --quick avoids the end pause. Both paths depend on the
# packaging (Debian/Ubuntu = /usr/sbin, EPEL = /usr/bin).
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/lynis audit system --quick --no-colors
nexus-agent ALL=(root) NOPASSWD: /usr/bin/lynis audit system --quick --no-colors
nexus-agent ALL=(root) NOPASSWD: /bin/cat /var/log/lynis-report.dat

# === Package pinning (apt-mark) ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-mark showhold
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-mark hold *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-mark unhold *

# === Netplan (watchdog-revert) ===
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/netplan apply
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/netplan/*.yaml
nexus-agent ALL=(root) NOPASSWD: /bin/rm -f /etc/netplan/*.yaml
# NEXUS-AGENT-008: writing netplan goes through `privhelper install-netplan`
# (src realpath under staging + dst *.yaml DIRECTLY under /etc/netplan, without
# traversal) — the `install … /etc/netplan/*.yaml` line (wildcard dest) is removed.

# === Linux users + SSH keys ===
# NEXUS-AGENT-003: user creation goes through `privhelper useradd`
# (validated login + `--` → no `-o -u 0`) — the `useradd *` lines are removed.
# NEXUS-AGENT-008: .ssh + authorized_keys go through `privhelper install-authkeys`
# (home resolved via getent, non-globbed derived dest) — the `install … /home/*`
# / `/root/*` lines are removed.
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/userdel -r *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/gpasswd -a * sudo
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/gpasswd -d * sudo
nexus-agent ALL=(root) NOPASSWD: /bin/cat /home/*/.ssh/authorized_keys
nexus-agent ALL=(root) NOPASSWD: /bin/cat /root/.ssh/authorized_keys
SUDOERS

# === Opt-in script.execute: root-RCE capability emitted ONLY if requested ===
# Appended outside the static heredoc. Without --allow-remote-script, the word
# "nexus-script" appears NOWHERE in the sudoers → `sudo /bin/bash
# nexus-script-*.sh` is refused by sudo itself (command out of the whitelist).
# This is a capability REMOVED from the system, not a bypassable application flag.
if [ "$ALLOW_REMOTE_SCRIPT" = "true" ]; then
    printf '\n# === Nexus scripts (opt-in --allow-remote-script; signed scripts, verified agent-side) ===\nnexus-agent ALL=(root) NOPASSWD: /bin/bash %s/nexus-script-*.sh\n' \
        "$AGENT_SCRIPT_DIR" >> "$SUDOERS_TEMP"
    warn "Remote script execution ENABLED (--allow-remote-script): root-RCE capability emitted in the sudoers."
fi

# Validate the syntax BEFORE applying
if visudo -cf "$SUDOERS_TEMP"; then
    install -m 0440 -o root -g root "$SUDOERS_TEMP" "$SUDOERS_FILE"
    ok "Sudoers configured: $SUDOERS_FILE"
else
    error "Invalid sudoers syntax! No changes applied."
    error "The existing $SUDOERS_FILE file (if any) was left untouched."
    exit 1
fi

info "Creating directories..."

mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$KEY_DIR"
mkdir -p "$LOG_DIR"

chown root:root "$INSTALL_DIR"
chown root:root "$CONFIG_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$KEY_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$LOG_DIR"

chmod 755 "$INSTALL_DIR"
chmod 755 "$CONFIG_DIR"
chmod 700 "$KEY_DIR"
chmod 755 "$LOG_DIR"

ok "Directories created."

# ===================== 3. Install the binary =====================

info "Installing the binary..."

# Refresh of an already-enrolled agent, with no binary supplied: we KEEP the
# binary in place. This is intentional — this mode serves to refresh sudoers/service
# (which self-upgrade cannot update) without overwriting/downgrading the binary that
# self-upgrade may have installed.
if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -z "$AGENT_BINARY" ] && [ ! -f "./nexus-agent" ] && [ -f "$BIN_PATH" ]; then
    chown root:root "$BIN_PATH"
    chmod 755 "$BIN_PATH"
    ok "Refresh: existing binary kept ($BIN_PATH, $(du -h "$BIN_PATH" | cut -f1)) — managed by self-upgrade."
else
    if [ -n "$AGENT_BINARY" ] && [ -f "$AGENT_BINARY" ]; then
        # Skip cp if source and destination are the same file (case where the binary
        # was downloaded directly into $BIN_PATH before the install)
        if [ "$(readlink -f "$AGENT_BINARY")" != "$(readlink -f "$BIN_PATH")" ]; then
            cp "$AGENT_BINARY" "$BIN_PATH"
        else
            ok "Binary already in place: $BIN_PATH"
        fi
    elif [ -f "./nexus-agent" ]; then
        cp "./nexus-agent" "$BIN_PATH"
    elif [ -f "$(dirname "$0")/../agent/nexus-agent" ]; then
        cp "$(dirname "$0")/../agent/nexus-agent" "$BIN_PATH"
    else
        # Try to extract from the Docker image
        if docker image inspect nexus-agent:latest &>/dev/null; then
            info "Extracting the binary from the Docker image..."
            CONTAINER_ID=$(docker create nexus-agent:latest)
            docker cp "$CONTAINER_ID:/usr/local/bin/nexus-agent" "$BIN_PATH"
            docker rm "$CONTAINER_ID" > /dev/null
        else
            error "nexus-agent binary not found. Use --binary <path>"
            exit 1
        fi
    fi

    chown root:root "$BIN_PATH"
    chmod 755 "$BIN_PATH"

    ok "Binary installed: $BIN_PATH ($(du -h "$BIN_PATH" | cut -f1))"
fi

# ===================== 4. Configuration file =====================

info "Creating the configuration..."

HOSTNAME_DETECTED=$(hostname -f 2>/dev/null || hostname)
IPS_DETECTED=$(ip -4 addr show | grep 'inet ' | grep -v '127.0.0.1' | grep -v 'docker' | grep -v 'br-' | grep -v 'veth' | awk '{print $2}' | cut -d/ -f1 | tr '\n' ',' | sed 's/,$//')

# Write the public key into a dedicated file (systemd EnvironmentFile does not
# support multi-line PEM values)
SERVER_PUBKEY_FILE="$CONFIG_DIR/server-public-key.pem"
if [ -n "${SERVER_PUBLIC_KEY:-}" ]; then
    printf '%s\n' "$SERVER_PUBLIC_KEY" > "$SERVER_PUBKEY_FILE"
    chown root:"$AGENT_GROUP" "$SERVER_PUBKEY_FILE"
    chmod 640 "$SERVER_PUBKEY_FILE"
fi

# Accept-list of release public keys (auto-upgrade verification,
# channel-independent). root:root 0644: only root writes, the agent (non-root)
# reads it. Absent ⇒ the agent refuses the auto-upgrade (fail-closed), but runs
# normally for everything else.
#
# Design A: the key is generally supplied by the bootstrap command (the
# backend embeds NEXUS_RELEASE_PUBKEY) → placed at install AND at reenroll
# (which purges $CONFIG_DIR, so the file does not exist → we write it).
# "Do not overwrite an existing pin" RULE: if a release.pub is ALREADY present
# (e.g. placed out-of-band by a high-assurance operator), we do NOT overwrite it,
# even if --release-pubkey-file is supplied. To change it: remove it then
# reinstall, or --reenroll (clean slate of $CONFIG_DIR).
RELEASE_PUBKEY_FILE="$CONFIG_DIR/release.pub"
if [ -n "${RELEASE_PUBKEY:-}" ]; then
    if [ -f "$RELEASE_PUBKEY_FILE" ]; then
        info "release.pub already present — pin kept (not overwritten)."
    else
        printf '%s\n' "$RELEASE_PUBKEY" > "$RELEASE_PUBKEY_FILE"
        chown root:root "$RELEASE_PUBKEY_FILE"
        chmod 644 "$RELEASE_PUBKEY_FILE"
        info "release.pub deployed (signed auto-upgrade verification)."
    fi
fi

# Accept-list DEDICATED to script signing (channel-independent lock for
# script.execute). Same model as release.pub: root:root 0644 (world-readable →
# the non-root agent reads it without CAP_DAC_READ_SEARCH, so independent of AGENT-002).
# Key distinct from the server key and the release key. Kept on REFRESH,
# re-supply on reenroll/uninstall.
SCRIPT_SIGNING_PUBKEY_FILE="$CONFIG_DIR/script-signing.pub"
if [ -n "${SCRIPT_SIGNING_PUBKEY:-}" ]; then
    printf '%s\n' "$SCRIPT_SIGNING_PUBKEY" > "$SCRIPT_SIGNING_PUBKEY_FILE"
    chown root:root "$SCRIPT_SIGNING_PUBKEY_FILE"
    chmod 644 "$SCRIPT_SIGNING_PUBKEY_FILE"
fi

# NEXUS-CRYPTO-001 — per-install salt for the at-rest encryption of agent.key
# (software machine-binding: HKDF(machine-id, salt)). INTENTIONAL scope-split:
# the salt lives in $CONFIG_DIR (/etc/nexus), the key in $KEY_DIR (/var/lib/nexus/
# keys) → an exfil scoped to a single dir misses one half. root:nexus-agent 0640:
# the agent reads it by group (no sudo, no cap). Generated once and
# KEPT on refresh (otherwise the existing key would become undecryptable);
# regenerated on --reenroll (clean slate of $CONFIG_DIR → new identity, new salt).
# LIMIT: a full disk snapshot/backup contains salt + machine-id → the key
# stays re-derivable. Only a TPM would close this case (not covered here).
KEY_SALT_FILE="$CONFIG_DIR/agent-keysalt"
if [ ! -f "$KEY_SALT_FILE" ]; then
    head -c 32 /dev/urandom | base64 > "$KEY_SALT_FILE"
    chown root:"$AGENT_GROUP" "$KEY_SALT_FILE"
    chmod 640 "$KEY_SALT_FILE"
fi

cat > "$CONFIG_DIR/agent.env" << EOF
# Nexus Agent Configuration
# Generated by install-agent.sh on $(date -Iseconds)

NEXUS_SERVER_URL=$SERVER_URL
NEXUS_MACHINE_ID=$MACHINE_ID
NEXUS_ENROLLMENT_TOKEN=$ENROLLMENT_TOKEN
NEXUS_SERVER_PUBLIC_KEY_FILE=$SERVER_PUBKEY_FILE
NEXUS_KEY_PATH=$KEY_DIR
NEXUS_HOSTNAME=$HOSTNAME_DETECTED
NEXUS_HOST_IPS=$IPS_DETECTED
NEXUS_HEARTBEAT_INTERVAL=$HEARTBEAT_INTERVAL
NEXUS_METRICS_INTERVAL=$METRICS_INTERVAL
EOF

# Cleartext transport allowed only with --insecure (local dev). Written only
# when active → the agent then logs a WARNING on every boot (cf. config.go).
if [ "$INSECURE" = "true" ]; then
    printf 'NEXUS_ALLOW_INSECURE=1\n' >> "$CONFIG_DIR/agent.env"
fi

chown root:"$AGENT_GROUP" "$CONFIG_DIR/agent.env"
chmod 640 "$CONFIG_DIR/agent.env"

ok "Configuration: $CONFIG_DIR/agent.env"
echo "  Hostname : $HOSTNAME_DETECTED"
echo "  IPs      : $IPS_DETECTED"

# ===================== 5. systemd service =====================

info "Installing the systemd service..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SYSTEMD'
[Unit]
Description=Nexus Agent - Infrastructure Management
Documentation=https://github.com/nexus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nexus-agent
Group=nexus-agent
# systemd creates /var/lib/nexus-agent automatically (owner=nexus-agent, mode=0700)
StateDirectory=nexus-agent
StateDirectoryMode=0700
ExecStart=/usr/local/bin/nexus-agent
EnvironmentFile=/etc/nexus/agent.env
Restart=always
RestartSec=10
WatchdogSec=120

# ===================== Security =====================

# The agent runs as nexus-agent (non-root)
# Privileged commands go through sudo (see /etc/sudoers.d/nexus-agent)
ProtectHome=true
PrivateTmp=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
# RestrictSUIDSGID removed: sudo is a SUID binary required for privileged actions
# The protection remains via the targeted sudoers (whitelist + NOEXEC)
RestrictRealtime=true
LockPersonality=true
# Address families: the agent only speaks TCP (WS); AF_NETLINK required to
# read network interfaces (ip addr), AF_UNIX for systemd/journald.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

# NEXUS-AGENT-002 — Linux capabilities at the strict minimum.
# The agent process (non-root) needs NO ambient capability: monitoring
# via /proc (standard reads), files via DAC, network over outbound TCP. The
# privileged operations go through sudo (root children via setuid). The legitimate
# root reads (certs) have a targeted `sudo cat` fallback (ssl_scan.go), so we
# no longer need CAP_DAC_READ_SEARCH (blind override of DAC).
AmbientCapabilities=
# TARGETED drift-guard: from the bounding set of the WHOLE unit (agent process AND
# sudo children) we remove the 2 attack capabilities the agent must NEVER hold —
#  - CAP_DAC_READ_SEARCH: reading ANY file while ignoring DAC
#    (bypassed the sudoers and would have defeated the at-rest encryption of
#     CRYPTO-001);
#  - CAP_SYS_PTRACE: inter-process ptrace attach (reading the memory of root daemons).
# Syntax `~` = "all EXCEPT these": the sudo children (apt/netplan/useradd…)
# keep CHOWN/FOWNER/DAC_OVERRIDE/SETUID/SETGID… which they need. An
# allow-list bounding set (e.g. CAP_NET_RAW alone) would ALSO cap the sudo
# children and break the privileged actions across the whole fleet.
CapabilityBoundingSet=~CAP_DAC_READ_SEARCH CAP_SYS_PTRACE

# SystemCallFilter removed: interferes with sudo (audit syscalls) and apt-get
# The protection remains via the other directives (Protect*, capabilities, sudoers)
SystemCallArchitectures=native

# NB: ProtectSystem stays in non-strict mode intentionally. The "strict" mode
# would impose a RO mount that would ALSO apply to the child sudo processes
# (apt/netplan/users write to /usr, /etc, /var, /home) and break the
# privileged actions. So we limit ourselves to targeted ReadOnlyPaths.
# Accessible directories
ReadOnlyPaths=/proc /sys /etc/os-release
ReadWritePaths=/var/lib/nexus/keys /var/lib/nexus-agent /var/log/nexus

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload

ok "systemd service installed: ${SERVICE_NAME}.service"

# ===================== 6. Start =====================

echo ""
info "Starting the agent..."

systemctl enable "$SERVICE_NAME" --now

sleep 5

if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Agent started successfully!"
    echo ""
    echo -e "${GREEN}=== Installation complete ===${NC}"
    echo ""
    echo -e "  ${GREEN}Refreshed:${NC} sudoers ($SUDOERS_FILE) + systemd service"
    echo "  (these are precisely the files that self-upgrade cannot update)"
    echo ""
    echo "  Useful commands:"
    echo "    systemctl status $SERVICE_NAME     # Status"
    echo "    journalctl -u $SERVICE_NAME -f     # Live logs"
    echo "    systemctl restart $SERVICE_NAME    # Restart"
    echo "    systemctl stop $SERVICE_NAME       # Stop"
    echo ""
    echo "  Files:"
    echo "    Binary : $BIN_PATH"
    echo "    Config : $CONFIG_DIR/agent.env"
    echo "    Keys   : $KEY_DIR/"
    echo "    Logs   : journalctl -u $SERVICE_NAME"
    echo ""

    # Show the first log lines
    journalctl -u "$SERVICE_NAME" --no-pager -n 10 2>/dev/null || true
else
    error "The agent did not start."
    journalctl -u "$SERVICE_NAME" --no-pager -n 20 2>/dev/null || true
    exit 1
fi
