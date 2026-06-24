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
AGENT_SCRIPT_DIR="/var/lib/nexus-agent"

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

# ===================== Fonctions de nettoyage =====================

# purge_state : supprime l'identité et l'état résiduel qui font échouer un
# ré-enrollement (clés ECDSA agent, shared secret, ancienne clé serveur,
# snapshots watchdog non confirmés, inbox, ancienne config). Conserve le
# binaire, le user, le sudoers et le service (réécrits par l'install).
# C'est LA correction du deadlock "l'agent saute l'enrollement car shared.secret
# existe et s'authentifie avec un secret que le backend ne connaît plus".
purge_state() {
    info "Purge de l'état résiduel (ré-enrollement propre)..."

    # Clés ECDSA agent + shared secret dérivé (cause n°1 du deadlock)
    rm -f "$KEY_DIR/agent.key" "$KEY_DIR/agent.pub" "$KEY_DIR/shared.secret"
    # Variante historique du KeyPath (config.go défaut /opt/nexus/keys)
    rm -f /opt/nexus/keys/agent.key /opt/nexus/keys/agent.pub /opt/nexus/keys/shared.secret

    # Ancienne clé publique serveur (régénérée à chaque re-enroll côté backend)
    rm -f "$CONFIG_DIR/server-public-key.pem"

    # Snapshots watchdog NON confirmés : dangereux, seraient revert au boot
    rm -f "$AGENT_SCRIPT_DIR"/firewall-snapshot-*.iptables 2>/dev/null || true
    rm -rf "$AGENT_SCRIPT_DIR"/netplan-snapshot-* 2>/dev/null || true
    # Scripts temporaires et tempfiles d'install résiduels
    rm -f "$AGENT_SCRIPT_DIR"/nexus-script-*.sh "$AGENT_SCRIPT_DIR"/nexus-agent.new \
          "$AGENT_SCRIPT_DIR"/sshkey-*.tmp 2>/dev/null || true

    # Ancienne config (réécrite ensuite avec le nouveau token / nouvelle clé)
    rm -f "$CONFIG_DIR/agent.env"

    ok "État résiduel purgé : l'agent se ré-enrôlera proprement."
}

# do_uninstall : suppression COMPLÈTE de l'agent (équivalent --purge).
# Exhaustif d'après l'audit : service, binaire, dirs, clés, sudoers, user, groupe.
do_uninstall() {
    echo ""
    echo -e "${BLUE}=== Nexus Agent - Désinstallation complète ===${NC}"
    echo ""

    # 1. Service systemd : stop + disable + suppression unit + reload
    if systemctl list-unit-files "${SERVICE_NAME}.service" &>/dev/null \
       && systemctl cat "${SERVICE_NAME}.service" &>/dev/null; then
        if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
            systemctl stop "$SERVICE_NAME" && ok "Service arrêté."
        fi
        systemctl disable "$SERVICE_NAME" &>/dev/null && ok "Service désactivé." || true
    fi
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE_NAME" &>/dev/null || true
    ok "Unit systemd supprimée."

    # 2. Binaire
    rm -f "$BIN_PATH" && ok "Binaire supprimé : $BIN_PATH"

    # 3. Clés, config, état, snapshots, logs, install dir (tout ce qui survit)
    rm -rf "$KEY_DIR" /var/lib/nexus /opt/nexus
    rm -rf "$CONFIG_DIR"
    rm -rf "$AGENT_SCRIPT_DIR"        # /var/lib/nexus-agent (snapshots/inbox/scripts)
    rm -rf "$LOG_DIR"
    ok "Clés, config, état et snapshots supprimés."

    # 4. Sudoers
    rm -f /etc/sudoers.d/nexus-agent && ok "Sudoers supprimé."

    # 5. Utilisateur système + retrait du groupe
    if id "$AGENT_USER" &>/dev/null; then
        gpasswd -d "$AGENT_USER" systemd-journal &>/dev/null || true
        userdel "$AGENT_USER" &>/dev/null && ok "Utilisateur '$AGENT_USER' supprimé." || \
            warn "Impossible de supprimer l'utilisateur '$AGENT_USER' (processus en cours ?)."
    fi

    echo ""
    echo -e "${GREEN}=== Désinstallation terminée ===${NC}"
    echo "Les backups /etc/sudoers.bak.* ne sont pas touchés (suppression manuelle si besoin)."
    echo ""
}

# ===================== Paramètres =====================

SERVER_URL=""
MACHINE_ID=""
ENROLLMENT_TOKEN=""
SERVER_PUBLIC_KEY=""
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
                error "Fichier cle publique introuvable: $2"
                exit 1
            fi
            SERVER_PUBLIC_KEY="$(cat "$2")"
            shift 2 ;;
        --binary)           AGENT_BINARY="$2";      shift 2 ;;
        --heartbeat)        HEARTBEAT_INTERVAL="$2"; shift 2 ;;
        --metrics)          METRICS_INTERVAL="$2";  shift 2 ;;
        --uninstall|--purge) MODE="uninstall";      shift ;;
        # --reenroll : purge l'identité résiduelle (clés, secret, snapshots,
        # ancienne clé serveur) AVANT de réinstaller/ré-enrôler proprement.
        --reenroll)         MODE="reenroll";        shift ;;
        -h|--help)
            echo "Usage:"
            echo "  install-agent.sh --server-url URL --machine-id ID --enrollment-token TOKEN [--server-public-key-file F]"
            echo "  install-agent.sh --reenroll  --server-url URL --machine-id ID --enrollment-token TOKEN [...]   # purge + réinstalle"
            echo "  install-agent.sh --uninstall                                                                   # suppression complète"
            exit 0 ;;
        *) error "Option inconnue: $1"; exit 1 ;;
    esac
done

# Mode désinstallation : pas besoin des params d'enrollment
if [ "$MODE" = "uninstall" ]; then
    do_uninstall
    exit 0
fi

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

# Le token n'est requis QUE si l'agent n'a pas déjà une identité locale
# (shared.secret). Pour un simple rafraîchissement sudoers/binaire sur une
# machine déjà enrôlée, l'agent réutilise ses clés existantes et ne ré-enrôle pas.
HAS_LOCAL_IDENTITY=false
if [ -f "$KEY_DIR/shared.secret" ] && [ "$MODE" != "reenroll" ]; then
    HAS_LOCAL_IDENTITY=true
fi

if [ -z "$ENROLLMENT_TOKEN" ] && [ "$HAS_LOCAL_IDENTITY" = false ]; then
    read -p "Token d'enrollment : " ENROLLMENT_TOKEN
fi

if [ -z "$SERVER_URL" ] || [ -z "$MACHINE_ID" ]; then
    error "server-url et machine-id sont requis."
    exit 1
fi

if [ -z "$ENROLLMENT_TOKEN" ] && [ "$HAS_LOCAL_IDENTITY" = false ]; then
    error "enrollment-token requis (aucune identité locale dans $KEY_DIR). Utilisez --reenroll pour repartir de zéro."
    exit 1
fi

if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -z "$ENROLLMENT_TOKEN" ]; then
    info "Identité locale détectée : rafraîchissement (sudoers/binaire) sans ré-enrollement."
    ENROLLMENT_TOKEN="__refresh__"   # placeholder, non utilisé (l'agent saute l'enrollement)
fi

# PINNING STRICT : la clé publique du serveur est obligatoire pour un (ré-)enrollement.
# En refresh (identité locale présente), la clé existante dans $CONFIG_DIR est conservée.
if [ "$HAS_LOCAL_IDENTITY" = false ] && [ -z "${SERVER_PUBLIC_KEY:-}" ]; then
    error "--server-public-key-file requis : la clé serveur est obligatoire (pinning d'isolation)."
    error "Utilisez la commande d'install générée par l'UI Nexus (elle inclut la clé)."
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

# Ré-enrollement : purger l'identité/état résiduel AVANT de reconfigurer, sinon
# l'agent saute l'enrollement (shared.secret présent) et reste en deadlock.
if [ "$MODE" = "reenroll" ]; then
    purge_state
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

# Note : on ne modifie JAMAIS /etc/sudoers (uniquement le drop-in
# /etc/sudoers.d/nexus-agent), donc pas de backup de /etc/sudoers — cela évitait
# l'accumulation de /etc/sudoers.bak.* à chaque réinstall.

# Créer le répertoire dédié pour les scripts agent (pas /tmp world-writable)
mkdir -p "$AGENT_SCRIPT_DIR"
chown "$AGENT_USER":"$AGENT_GROUP" "$AGENT_SCRIPT_DIR"
chmod 0700 "$AGENT_SCRIPT_DIR"

# Inbox pour les uploads via fs.upload (file browser). Owner agent, 0750 :
# l'utilisateur final passera en SSH + sudo pour déplacer ailleurs. Les
# fichiers sont écrits en 0640 et auto-supprimés après 7 jours par l'agent.
mkdir -p "$AGENT_SCRIPT_DIR/inbox"
chown "$AGENT_USER":"$AGENT_GROUP" "$AGENT_SCRIPT_DIR/inbox"
chmod 0750 "$AGENT_SCRIPT_DIR/inbox"

# Créer le fichier sudoers dans un temp sécurisé
SUDOERS_TEMP=$(mktemp -t nexus-agent-sudoers.XXXXXX)
trap "rm -f '$SUDOERS_TEMP'" EXIT

cat > "$SUDOERS_TEMP" << 'SUDOERS'
# Nexus Agent - Sudoers
# Commandes autorisées pour l'agent Nexus (sans mot de passe)
# Généré par install-agent.sh — NE PAS MODIFIER MANUELLEMENT

# === Package management (APT) ===
# === Self-introspection (lecture sudoers pour detecter drift) ===
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/sudoers.d/nexus-agent

# === APT ===
# upgrade/update : arguments EXACTS (pas de wildcard) — sinon `-o
# DPkg::Pre-Invoke=...` permettrait l'exécution de commandes root arbitraires.
# install/remove gardent un wildcard (noms de paquets, validés en Go par
# packageNameRegex) + NOEXEC.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-get update
nexus-agent ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade -y -q
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/apt-get install -y -qq *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/apt-get remove -y -qq *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/unattended-upgrades --minimal_upgrade_steps

# === Package management (DNF/YUM) === (arguments exacts, voir system_update.go)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf update --security -y -q
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf update -y -q
nexus-agent ALL=(root) NOPASSWD: /usr/bin/dnf upgrade -y -q
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/dnf install -y -q *
nexus-agent ALL=(root) NOPASSWD: NOEXEC: /usr/bin/dnf remove -y -q *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/yum update --security -y -q
nexus-agent ALL=(root) NOPASSWD: /usr/bin/yum update -y -q
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
# Services protégés : ssh/sshd (lock-out admin) et nexus-agent (self-DoS).
# La protection est en couches : sudoers ici (ligne de défense ultime), puis
# isCritical côté backend (machine-protection.ts) qui bloque docker/postgres/etc.
Cmnd_Alias NEXUS_BLOCKED_SVC = /usr/bin/systemctl stop ssh*, \
                                /usr/bin/systemctl stop sshd*, \
                                /usr/bin/systemctl restart ssh*, \
                                /usr/bin/systemctl restart sshd*, \
                                /usr/bin/systemctl reload ssh*, \
                                /usr/bin/systemctl reload sshd*, \
                                /usr/bin/systemctl disable ssh*, \
                                /usr/bin/systemctl disable sshd*, \
                                /usr/bin/systemctl stop nexus-agent*, \
                                /usr/bin/systemctl restart nexus-agent*, \
                                /usr/bin/systemctl reload nexus-agent*, \
                                /usr/bin/systemctl disable nexus-agent*

nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start *, /usr/bin/systemctl stop *, /usr/bin/systemctl restart *, /usr/bin/systemctl reload *, /usr/bin/systemctl enable *, !NEXUS_BLOCKED_SVC

# === Remédiations de durcissement (Phase 2 — écriture de configs) ===
# fail2ban (anti-bruteforce) et unattended-upgrades (MAJ auto). Destinations fixes.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-fail2ban-*.tmp /etc/fail2ban/jail.local
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-autoupd-*.tmp /etc/apt/apt.conf.d/20auto-upgrades

# === Assistant pare-feu : sockets en écoute (lecture seule) ===
# ss -p (noms de process) nécessite root. Chemins selon packaging (sbin/bin).
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/ss -Htlnp
nexus-agent ALL=(root) NOPASSWD: /usr/bin/ss -Htlnp

# === Durcissement SSH (drop-in + watchdog-revert) ===
# Drop-in Nexus uniquement (99-nexus-hardening.conf) ; sshd -t valide AVANT reload.
# Le rechargement se fait par SIGHUP (kill, déjà whitelisté) — `systemctl reload ssh`
# reste BLOQUÉ pour éviter le lock-out. /bin/cat lecture du drop-in pour snapshot.
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/sshd -t
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/ssh/sshd_config.d/99-nexus-hardening.conf
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/* /etc/ssh/sshd_config.d/99-nexus-hardening.conf
nexus-agent ALL=(root) NOPASSWD: /bin/rm -f /etc/ssh/sshd_config.d/99-nexus-hardening.conf

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

# === SSL cert scanning ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/find /etc/letsencrypt/live *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/find /etc/letsencrypt/live /etc/ssl/private /etc/nginx/ssl /etc/apache2/ssl /etc/haproxy/certs *
nexus-agent ALL=(root) NOPASSWD: /usr/bin/find /etc/letsencrypt/live /etc/ssl/private /etc/ssl/certs/ssl-cert-snakeoil.pem /etc/nginx/ssl /etc/apache2/ssl /etc/haproxy/certs *
# CERTIFICATS uniquement — JAMAIS les clés privées. On exclut privkey.pem
# (Let's Encrypt), tout /etc/ssl/private (répertoire de clés par définition) et
# les globs trop larges (/etc/nginx/ssl/* lirait les .key). ssl.scan ne parse
# que des certificats ; un cat refusé est ignoré proprement.
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/letsencrypt/live/*/fullchain.pem
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/letsencrypt/live/*/cert.pem
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/letsencrypt/live/*/chain.pem
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/nginx/ssl/*.crt
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/apache2/ssl/*.crt
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/haproxy/certs/*.crt

# === Audit de sécurité (Lynis — lecture seule) ===
# audit system --quick --no-colors : audit non interactif, sortie streamée (pas
# de modif système). --quick évite la pause de fin. Les deux chemins selon le
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
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 600 -o root -g root /var/lib/nexus-agent/* /etc/netplan/*.yaml

# === Users Linux + SSH keys ===
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/useradd -m -s /bin/bash *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/useradd -m -s /bin/bash -c * *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/userdel -r *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/gpasswd -a * sudo
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/gpasswd -d * sudo
nexus-agent ALL=(root) NOPASSWD: /bin/cat /home/*/.ssh/authorized_keys
nexus-agent ALL=(root) NOPASSWD: /bin/cat /root/.ssh/authorized_keys
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -d -m 700 -o * -g * /home/*/.ssh
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -d -m 700 -o * -g * /root/.ssh
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 600 -o * -g * /var/lib/nexus-agent/sshkey-*.tmp /home/*/.ssh/authorized_keys
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 600 -o * -g * /var/lib/nexus-agent/sshkey-*.tmp /root/.ssh/authorized_keys
SUDOERS

# Valider la syntaxe AVANT d'appliquer
if visudo -cf "$SUDOERS_TEMP"; then
    install -m 0440 -o root -g root "$SUDOERS_TEMP" "$SUDOERS_FILE"
    ok "Sudoers configuré : $SUDOERS_FILE"
else
    error "Syntaxe sudoers invalide ! Aucune modification appliquée."
    error "Le fichier $SUDOERS_FILE existant (s'il existe) n'a pas été touché."
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
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
# RestrictSUIDSGID retire : sudo est un binaire SUID necessaire pour les actions privilegiees
# La protection reste via le sudoers ciblé (whitelist + NOEXEC)
RestrictRealtime=true
LockPersonality=true
# Familles d'adresses : l'agent ne parle qu'en TCP (WS) ; AF_NETLINK requis pour
# lire les interfaces réseau (ip addr), AF_UNIX pour systemd/journald.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

# Capabilities Linux minimales pour le monitoring
# Ambient: promues au non-root nexus-agent
# Pas de CapabilityBoundingSet : apt/sudo ont besoin du full set (chown, fowner, etc.)
AmbientCapabilities=CAP_NET_RAW CAP_SYS_PTRACE CAP_DAC_READ_SEARCH

# SystemCallFilter retire : interfere avec sudo (audit syscalls) et apt-get
# La protection reste via les autres directives (Protect*, capabilities, sudoers)
SystemCallArchitectures=native

# NB : ProtectSystem reste en mode non-strict volontairement. Le mode "strict"
# imposerait un montage RO qui s'appliquerait AUSSI aux processus sudo enfants
# (apt/netplan/users écrivent dans /usr, /etc, /var, /home) et casserait les
# actions privilégiées. On se limite donc à ReadOnlyPaths ciblés.
# Répertoires accessibles
ReadOnlyPaths=/proc /sys /etc/os-release
ReadWritePaths=/var/lib/nexus/keys /var/lib/nexus-agent /var/log/nexus

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
