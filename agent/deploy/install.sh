#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Nexus Agent — Install Script (léger, pour déploiement avec binaire fourni)
# Crée le user système, configure sudo, installe le binaire et le service.
# Pour une installation complète, utilisez scripts/install-agent.sh
# ============================================================================

AGENT_USER="nexus-agent"
AGENT_GROUP="nexus-agent"
BINARY_NAME="nexus-agent"
BINARY_PATH="/usr/local/bin/${BINARY_NAME}"
CONFIG_DIR="/etc/nexus"
ENV_FILE="${CONFIG_DIR}/agent.env"
KEYS_DIR="/var/lib/nexus/keys"
SERVICE_NAME="nexus-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- Helpers ----------------------------------------------------------

log_info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
log_ok()    { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
log_err()   { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

usage() {
    cat <<EOF
Usage: $0 --server URL --token TOKEN --machine-id ID --server-key KEY

Required parameters:
  --server      Nexus server URL (e.g. https://nexus.example.com)
  --token       Agent registration token
  --machine-id  Unique machine identifier
  --server-key  Server public key (base64)

Options:
  --binary PATH Path to the nexus-agent binary (default: same directory as this script)
  -h, --help    Show this help message
EOF
    exit 1
}

fail() {
    log_err "$1"
    exit 1
}

# ---------- Root check -------------------------------------------------------

if [[ "$(id -u)" -ne 0 ]]; then
    fail "This script must be run as root."
fi

# ---------- Parse arguments --------------------------------------------------

SERVER_URL=""
TOKEN=""
MACHINE_ID=""
SERVER_KEY=""
BINARY_SOURCE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)
            [[ -n "${2:-}" ]] || fail "--server requires a value"
            SERVER_URL="$2"; shift 2 ;;
        --token)
            [[ -n "${2:-}" ]] || fail "--token requires a value"
            TOKEN="$2"; shift 2 ;;
        --machine-id)
            [[ -n "${2:-}" ]] || fail "--machine-id requires a value"
            MACHINE_ID="$2"; shift 2 ;;
        --server-key)
            [[ -n "${2:-}" ]] || fail "--server-key requires a value"
            SERVER_KEY="$2"; shift 2 ;;
        --binary)
            [[ -n "${2:-}" ]] || fail "--binary requires a value"
            BINARY_SOURCE="$2"; shift 2 ;;
        -h|--help)
            usage ;;
        *)
            fail "Unknown argument: $1" ;;
    esac
done

# Validate required parameters
[[ -n "$SERVER_URL" ]]  || fail "Missing required parameter: --server"
[[ -n "$TOKEN" ]]       || fail "Missing required parameter: --token"
[[ -n "$MACHINE_ID" ]]  || fail "Missing required parameter: --machine-id"
[[ -n "$SERVER_KEY" ]]  || fail "Missing required parameter: --server-key"

# ---------- Resolve binary source --------------------------------------------

if [[ -z "$BINARY_SOURCE" ]]; then
    BINARY_SOURCE="${SCRIPT_DIR}/${BINARY_NAME}"
fi

if [[ ! -f "$BINARY_SOURCE" ]]; then
    fail "Binary not found at ${BINARY_SOURCE}. Use --binary to specify the path."
fi

# ---------- Create system user -----------------------------------------------

if ! id -u "$AGENT_USER" &>/dev/null; then
    log_info "Creating system user '$AGENT_USER'..."
    useradd --system --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
    log_ok "User '$AGENT_USER' created."
else
    log_ok "User '$AGENT_USER' already exists."
fi

# ---------- Configure sudoers ------------------------------------------------

log_info "Configuring sudo privileges for '$AGENT_USER'..."

SUDOERS_FILE="/etc/sudoers.d/nexus-agent"
SUDOERS_BACKUP="/etc/sudoers.bak.$(date +%s)"
AGENT_SCRIPT_DIR="/var/lib/nexus-agent"

# Backup du sudoers principal
cp /etc/sudoers "$SUDOERS_BACKUP"
log_ok "Sudoers backup: $SUDOERS_BACKUP"

# Répertoire dédié pour les scripts agent (pas /tmp)
mkdir -p "$AGENT_SCRIPT_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$AGENT_SCRIPT_DIR"
chmod 0700 "$AGENT_SCRIPT_DIR"

SUDOERS_TEMP=$(mktemp -t nexus-agent-sudoers.XXXXXX)
trap "rm -f '$SUDOERS_TEMP'" EXIT

cat > "$SUDOERS_TEMP" << 'SUDOERS'
# Nexus Agent - Sudoers
# Commandes autorisées pour l'agent Nexus (sans mot de passe)

# === Package management (APT) ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-get update
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade -y *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/apt-get install -y -qq *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/apt-get remove -y -qq *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/unattended-upgrades --minimal_upgrade_steps

# === Package management (DNF/YUM) ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf update -y *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf upgrade -y *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/dnf install -y -q *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/dnf remove -y -q *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/yum update -y *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/yum install -y -q *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/yum remove -y -q *

# === Processus (signaux explicites uniquement) ===
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGTERM [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGKILL [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGHUP [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGINT [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGUSR1 [0-9]*
nexus-agent ALL=(root) NOPASSWD: /bin/kill -SIGUSR2 [0-9]*

# === Scripts Nexus (répertoire dédié, pas /tmp) ===
nexus-agent ALL=(root) NOPASSWD: /bin/bash /var/lib/nexus-agent/nexus-script-*.sh

# === Reboot ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
SUDOERS

if visudo -cf "$SUDOERS_TEMP"; then
    install -m 0440 -o root -g root "$SUDOERS_TEMP" "$SUDOERS_FILE"
    log_ok "Sudoers configured: $SUDOERS_FILE"
else
    fail "Invalid sudoers syntax! No changes applied. Backup: $SUDOERS_BACKUP"
fi

# ---------- Install binary ---------------------------------------------------

log_info "Installing binary to ${BINARY_PATH}..."
cp -f "$BINARY_SOURCE" "$BINARY_PATH"
chmod 0755 "$BINARY_PATH"
chown root:root "$BINARY_PATH"
log_ok "Binary installed."

# ---------- Create config directory and env file -----------------------------

log_info "Creating configuration directory ${CONFIG_DIR}..."
mkdir -p "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"
chown root:"$AGENT_GROUP" "$CONFIG_DIR"

log_info "Writing environment file ${ENV_FILE}..."
cat > "$ENV_FILE" <<EOF
# Nexus Agent configuration — generated by install.sh
NEXUS_SERVER_URL=${SERVER_URL}
NEXUS_TOKEN=${TOKEN}
NEXUS_MACHINE_ID=${MACHINE_ID}
NEXUS_SERVER_KEY=${SERVER_KEY}
EOF
chmod 0640 "$ENV_FILE"
chown root:"$AGENT_GROUP" "$ENV_FILE"
log_ok "Configuration written."

# ---------- Create keys directory --------------------------------------------

log_info "Creating keys directory ${KEYS_DIR}..."
mkdir -p "$KEYS_DIR"
chmod 0700 "$KEYS_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$KEYS_DIR"
log_ok "Keys directory ready."

# ---------- Install systemd service ------------------------------------------

SERVICE_SOURCE="${SCRIPT_DIR}/nexus-agent.service"
if [[ ! -f "$SERVICE_SOURCE" ]]; then
    fail "Service file not found at ${SERVICE_SOURCE}."
fi

log_info "Installing systemd service..."
cp -f "$SERVICE_SOURCE" "$SERVICE_FILE"
chmod 0644 "$SERVICE_FILE"

systemctl daemon-reload
log_ok "Systemd service installed."

# ---------- Enable and start ------------------------------------------------

log_info "Enabling and starting ${SERVICE_NAME}..."
systemctl enable --now "$SERVICE_NAME"
log_ok "Service enabled and started."

# ---------- Show status ------------------------------------------------------

echo ""
log_info "Service status:"
systemctl status "$SERVICE_NAME" --no-pager --lines=5 || true

echo ""
log_ok "Nexus Agent installation complete."
log_info "  Binary:  ${BINARY_PATH}"
log_info "  Config:  ${ENV_FILE}"
log_info "  Keys:    ${KEYS_DIR}"
log_info "  Sudoers: ${SUDOERS_FILE}"
log_info "  Service: ${SERVICE_NAME} (User=${AGENT_USER})"
