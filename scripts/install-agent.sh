#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Nexus Agent - Script d'installation
# ============================================
# Usage :
#   sudo ./install-agent.sh \
#     --server-url wss://nexus.example.com/ws/agent \
#     --machine-id <id> \
#     --enrollment-token <token>
#
# Ou interactif :
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

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ===================== Vérifications =====================

if [ "$EUID" -ne 0 ]; then
    error "Ce script doit être lancé en root (sudo)."
    exit 1
fi

# ===================== Paramètres =====================

SERVER_URL=""
MACHINE_ID=""
ENROLLMENT_TOKEN=""
SERVER_PUBLIC_KEY=""
AGENT_BINARY=""
HEARTBEAT_INTERVAL=30
METRICS_INTERVAL=60

while [[ $# -gt 0 ]]; do
    case $1 in
        --server-url)       SERVER_URL="$2";        shift 2 ;;
        --machine-id)       MACHINE_ID="$2";        shift 2 ;;
        --enrollment-token) ENROLLMENT_TOKEN="$2";  shift 2 ;;
        --server-public-key) SERVER_PUBLIC_KEY="$2"; shift 2 ;;
        --server-public-key-file)
            if [ ! -f "$2" ]; then
                error "Fichier cle publique introuvable: $2"
                exit 1
            fi
            SERVER_PUBLIC_KEY="$(cat "$2")"
            shift 2 ;;
        --binary)           AGENT_BINARY="$2";      shift 2 ;;
        --heartbeat)        HEARTBEAT_INTERVAL="$2"; shift 2 ;;
        --metrics)          METRICS_INTERVAL="$2";  shift 2 ;;
        *) error "Option inconnue: $1"; exit 1 ;;
    esac
done

# Mode interactif si les params manquent
if [ -z "$SERVER_URL" ]; then
    echo ""
    echo -e "${BLUE}=== Nexus Agent - Installation ===${NC}"
    echo ""
    read -p "URL du serveur Nexus (ex: ws://nexus:26031/ws/agent) : " SERVER_URL
fi

if [ -z "$MACHINE_ID" ]; then
    read -p "Machine ID : " MACHINE_ID
fi

if [ -z "$ENROLLMENT_TOKEN" ]; then
    read -p "Token d'enrollment : " ENROLLMENT_TOKEN
fi

if [ -z "$SERVER_URL" ] || [ -z "$MACHINE_ID" ] || [ -z "$ENROLLMENT_TOKEN" ]; then
    error "server-url, machine-id et enrollment-token sont requis."
    exit 1
fi

echo ""
info "Configuration :"
echo "  Server URL    : $SERVER_URL"
echo "  Machine ID    : $MACHINE_ID"
echo "  Token         : ${ENROLLMENT_TOKEN:0:20}..."
echo ""

# ===================== 0. Arrêter l'agent s'il tourne déjà (re-install) =====================

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Agent en cours d'exécution, arrêt avant réinstall..."
    systemctl stop "$SERVICE_NAME"
    ok "Agent arrêté."
fi

# ===================== 1. Créer l'utilisateur système =====================

info "Création de l'utilisateur système '$AGENT_USER'..."

if id "$AGENT_USER" &>/dev/null; then
    ok "L'utilisateur '$AGENT_USER' existe déjà."
else
    useradd \
        --system \
        --no-create-home \
        --home-dir "$INSTALL_DIR" \
        --shell /usr/sbin/nologin \
        --comment "Nexus Agent" \
        "$AGENT_USER"
    ok "Utilisateur '$AGENT_USER' créé."
fi

# Ajouter au groupe systemd-journal pour la lecture des logs via journalctl
# (evite d'avoir a whitelister journalctl dans sudoers)
if getent group systemd-journal > /dev/null; then
    usermod -a -G systemd-journal "$AGENT_USER"
    ok "Ajoute au groupe systemd-journal pour la lecture des logs."
fi

# ===================== 2. Configurer sudoers (commandes privilégiées) =====================

info "Configuration des privilèges sudo pour '$AGENT_USER'..."

SUDOERS_FILE="/etc/sudoers.d/nexus-agent"
SUDOERS_BACKUP="/etc/sudoers.bak.$(date +%s)"
AGENT_SCRIPT_DIR="/var/lib/nexus-agent"

# Backup du sudoers principal (sécurité)
cp /etc/sudoers "$SUDOERS_BACKUP"
ok "Backup sudoers : $SUDOERS_BACKUP"

# Créer le répertoire dédié pour les scripts agent (pas /tmp world-writable)
mkdir -p "$AGENT_SCRIPT_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$AGENT_SCRIPT_DIR"
chmod 0700 "$AGENT_SCRIPT_DIR"

# Créer le fichier sudoers dans un temp sécurisé
SUDOERS_TEMP=$(mktemp -t nexus-agent-sudoers.XXXXXX)
trap "rm -f '$SUDOERS_TEMP'" EXIT

cat > "$SUDOERS_TEMP" << 'SUDOERS'
# Nexus Agent - Sudoers
# Commandes autorisées pour l'agent Nexus (sans mot de passe)
# Généré par install-agent.sh — NE PAS MODIFIER MANUELLEMENT

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

# === Services systemd (start/stop/restart/reload) ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl stop *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl reload *

# === Firewall ufw + iptables (pour snapshot/restore watchdog) ===
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw status *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw status
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw allow *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw deny *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw --force delete [0-9]*
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw --force enable
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ufw disable
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/iptables-save
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/iptables-restore

# === Self-upgrade (remplacement du binaire agent) ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 755 /var/lib/nexus-agent/nexus-agent.new /usr/local/bin/nexus-agent

# === LVM report (storage overview) ===
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/pvs --reportformat json --units b --nosuffix -o *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/vgs --reportformat json --units b --nosuffix -o *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/lvs --reportformat json --units b --nosuffix -o *
SUDOERS

# Valider la syntaxe AVANT d'appliquer
if visudo -cf "$SUDOERS_TEMP"; then
    install -m 0440 -o root -g root "$SUDOERS_TEMP" "$SUDOERS_FILE"
    ok "Sudoers configuré : $SUDOERS_FILE"
else
    error "Syntaxe sudoers invalide ! Aucune modification appliquée."
    error "Le backup est disponible : $SUDOERS_BACKUP"
    exit 1
fi

info "Création des répertoires..."

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

ok "Répertoires créés."

# ===================== 3. Installer le binaire =====================

info "Installation du binaire..."

if [ -n "$AGENT_BINARY" ] && [ -f "$AGENT_BINARY" ]; then
    # Skip cp if source and destination are the same file (cas ou le binaire
    # a ete telecharge directement dans $BIN_PATH avant l'install)
    if [ "$(readlink -f "$AGENT_BINARY")" != "$(readlink -f "$BIN_PATH")" ]; then
        cp "$AGENT_BINARY" "$BIN_PATH"
    else
        ok "Binaire deja en place : $BIN_PATH"
    fi
elif [ -f "./nexus-agent" ]; then
    cp "./nexus-agent" "$BIN_PATH"
elif [ -f "$(dirname "$0")/../agent/nexus-agent" ]; then
    cp "$(dirname "$0")/../agent/nexus-agent" "$BIN_PATH"
else
    # Essayer d'extraire depuis l'image Docker
    if docker image inspect nexus-agent:latest &>/dev/null; then
        info "Extraction du binaire depuis l'image Docker..."
        CONTAINER_ID=$(docker create nexus-agent:latest)
        docker cp "$CONTAINER_ID:/usr/local/bin/nexus-agent" "$BIN_PATH"
        docker rm "$CONTAINER_ID" > /dev/null
    else
        error "Binaire nexus-agent introuvable. Utilisez --binary <chemin>"
        exit 1
    fi
fi

chown root:root "$BIN_PATH"
chmod 755 "$BIN_PATH"

ok "Binaire installé : $BIN_PATH ($(du -h "$BIN_PATH" | cut -f1))"

# ===================== 4. Fichier de configuration =====================

info "Création de la configuration..."

HOSTNAME_DETECTED=$(hostname -f 2>/dev/null || hostname)
IPS_DETECTED=$(ip -4 addr show | grep 'inet ' | grep -v '127.0.0.1' | grep -v 'docker' | grep -v 'br-' | grep -v 'veth' | awk '{print $2}' | cut -d/ -f1 | tr '\n' ',' | sed 's/,$//')

# Ecrire la cle publique dans un fichier dedie (systemd EnvironmentFile ne
# supporte pas les valeurs multi-lignes PEM)
SERVER_PUBKEY_FILE="$CONFIG_DIR/server-public-key.pem"
if [ -n "${SERVER_PUBLIC_KEY:-}" ]; then
    printf '%s\n' "$SERVER_PUBLIC_KEY" > "$SERVER_PUBKEY_FILE"
    chown root:"$AGENT_GROUP" "$SERVER_PUBKEY_FILE"
    chmod 640 "$SERVER_PUBKEY_FILE"
fi

cat > "$CONFIG_DIR/agent.env" << EOF
# Nexus Agent Configuration
# Généré par install-agent.sh le $(date -Iseconds)

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

chown root:"$AGENT_GROUP" "$CONFIG_DIR/agent.env"
chmod 640 "$CONFIG_DIR/agent.env"

ok "Configuration : $CONFIG_DIR/agent.env"
echo "  Hostname : $HOSTNAME_DETECTED"
echo "  IPs      : $IPS_DETECTED"

# ===================== 5. Service systemd =====================

info "Installation du service systemd..."

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
# systemd cree /var/lib/nexus-agent automatiquement (owner=nexus-agent, mode=0700)
StateDirectory=nexus-agent
StateDirectoryMode=0700
ExecStart=/usr/local/bin/nexus-agent
EnvironmentFile=/etc/nexus/agent.env
Restart=always
RestartSec=10
WatchdogSec=120

# ===================== Sécurité =====================

# L'agent tourne sous nexus-agent (non-root)
# Les commandes privilégiées passent par sudo (voir /etc/sudoers.d/nexus-agent)
ProtectHome=true
PrivateTmp=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectControlGroups=true
# RestrictSUIDSGID retire : sudo est un binaire SUID necessaire pour les actions privilegiees
# La protection reste via le sudoers ciblé (whitelist + NOEXEC)
RestrictRealtime=true
LockPersonality=true

# Capabilities Linux minimales pour le monitoring
# Ambient: promues au non-root nexus-agent
# Pas de CapabilityBoundingSet : apt/sudo ont besoin du full set (chown, fowner, etc.)
AmbientCapabilities=CAP_NET_RAW CAP_SYS_PTRACE CAP_DAC_READ_SEARCH

# SystemCallFilter retire : interfere avec sudo (audit syscalls) et apt-get
# La protection reste via les autres directives (Protect*, capabilities, sudoers)
SystemCallArchitectures=native

# Répertoires accessibles
ReadOnlyPaths=/proc /sys /etc/os-release
ReadWritePaths=/var/lib/nexus/keys /var/log/nexus

# Limites de ressources
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload

ok "Service systemd installé : ${SERVICE_NAME}.service"

# ===================== 6. Démarrer =====================

echo ""
info "Démarrage de l'agent..."

systemctl enable "$SERVICE_NAME" --now

sleep 5

if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Agent démarré avec succès !"
    echo ""
    echo -e "${GREEN}=== Installation terminée ===${NC}"
    echo ""
    echo "  Commandes utiles :"
    echo "    systemctl status $SERVICE_NAME     # Statut"
    echo "    journalctl -u $SERVICE_NAME -f     # Logs en direct"
    echo "    systemctl restart $SERVICE_NAME    # Redémarrer"
    echo "    systemctl stop $SERVICE_NAME       # Arrêter"
    echo ""
    echo "  Fichiers :"
    echo "    Binaire : $BIN_PATH"
    echo "    Config  : $CONFIG_DIR/agent.env"
    echo "    Clés    : $KEY_DIR/"
    echo "    Logs    : journalctl -u $SERVICE_NAME"
    echo ""

    # Afficher les premières lignes de log
    journalctl -u "$SERVICE_NAME" --no-pager -n 10 2>/dev/null || true
else
    error "L'agent n'a pas démarré."
    journalctl -u "$SERVICE_NAME" --no-pager -n 20 2>/dev/null || true
    exit 1
fi
