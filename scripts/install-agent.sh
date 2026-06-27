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

# wipe_agent : suppression COMPLÈTE de l'agent (table rase) — service, binaire,
# clés, shared secret, clé serveur, config, état/snapshots, SUDOERS, utilisateur.
# Argument "keep-logs" → conserve $LOG_DIR (cas du ré-enrollement), sinon les
# logs sont aussi supprimés (cas --uninstall).
# Réutilisé par do_uninstall ET par --reenroll : un ré-enrôlement repart donc
# d'une base propre (sudoers/user/binaire inclus), pas seulement de l'identité.
wipe_agent() {
    local keep_logs="${1:-}"

    # 1. Service systemd : stop + disable + suppression unit + reload
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        systemctl stop "$SERVICE_NAME" && ok "Service arrêté."
    fi
    systemctl disable "$SERVICE_NAME" &>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE_NAME" &>/dev/null || true
    ok "Unit systemd supprimée."

    # 1bis. S'assurer qu'AUCUN process agent ne survit. Sinon `userdel` échoue
    # ET — plus grave — l'ancien agent reste connecté avec l'ancienne identité
    # et entre en conflit avec le nouveau lors du ré-enrôlement (échec du check
    # ECDSA / session WS volée). On termine proprement puis on force.
    if id "$AGENT_USER" &>/dev/null; then
        pkill -TERM -u "$AGENT_USER" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            pgrep -u "$AGENT_USER" >/dev/null 2>&1 || break
            sleep 1
        done
        pkill -KILL -u "$AGENT_USER" 2>/dev/null || true
    fi

    # 2. Binaire
    rm -f "$BIN_PATH"
    ok "Binaire supprimé : $BIN_PATH"

    # 3. Clés, shared secret, clé serveur, config, état/snapshots (+ logs si non conservés)
    rm -rf "$KEY_DIR" /opt/nexus/keys /var/lib/nexus /opt/nexus
    rm -rf "$CONFIG_DIR"
    rm -rf "$AGENT_SCRIPT_DIR"        # /var/lib/nexus-agent (snapshots/inbox/scripts/tempfiles)
    if [ "$keep_logs" = "keep-logs" ]; then
        ok "Clés, config, état et snapshots supprimés (logs conservés)."
    else
        rm -rf "$LOG_DIR"
        ok "Clés, config, état, snapshots et logs supprimés."
    fi

    # 4. Sudoers (table rase — réécrit ensuite par l'install)
    rm -f /etc/sudoers.d/nexus-agent
    ok "Sudoers supprimé."

    # 5. Utilisateur système + retrait du groupe
    if id "$AGENT_USER" &>/dev/null; then
        gpasswd -d "$AGENT_USER" systemd-journal &>/dev/null || true
        userdel "$AGENT_USER" &>/dev/null && ok "Utilisateur '$AGENT_USER' supprimé." || \
            warn "Impossible de supprimer l'utilisateur '$AGENT_USER' (processus en cours ?)."
    fi
}

# do_uninstall : suppression complète (--purge), logs inclus.
do_uninstall() {
    echo ""
    echo -e "${BLUE}=== Nexus Agent - Désinstallation complète ===${NC}"
    echo ""
    wipe_agent
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
RELEASE_PUBKEY=""
SCRIPT_SIGNING_PUBKEY=""
ALLOW_REMOTE_SCRIPT="false"   # opt-in : émet la ligne sudoers bash nexus-script
INSECURE="false"             # opt-in dev : autorise un server-url non-wss:// (NEXUS_ALLOW_INSECURE)
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
        --release-pubkey-file)
            # Accept-list minisign des clés publiques de release (auto-upgrade).
            # Clé(s) générée(s) hors-ligne par l'opérateur ; seule la moitié
            # publique est déposée ici. Sans ce fichier, l'agent refuse toute
            # auto-mise-à-jour (fail-closed).
            if [ ! -f "$2" ]; then
                error "Fichier clé publique de release introuvable: $2"
                exit 1
            fi
            RELEASE_PUBKEY="$(cat "$2")"
            shift 2 ;;
        --script-signing-pubkey-file)
            # Accept-list minisign DÉDIÉE à la signature de script (distincte de
            # la clé serveur et de la clé de release). Privée hors-ligne côté
            # opérateur ; seule la moitié publique est déposée ici.
            if [ ! -f "$2" ]; then
                error "Fichier clé publique de signature de script introuvable: $2"
                exit 1
            fi
            SCRIPT_SIGNING_PUBKEY="$(cat "$2")"
            shift 2 ;;
        --allow-remote-script)
            # Opt-in EXPLICITE : sans ce flag, la ligne sudoers permettant
            # `sudo /bin/bash nexus-script-*.sh` n'est PAS écrite → la capacité
            # root-RCE n'existe pas sur le système (pas seulement un flag refusé).
            ALLOW_REMOTE_SCRIPT="true"; shift ;;
        --insecure)
            # Opt-in DEV uniquement : autorise un --server-url non-wss:// et pose
            # NEXUS_ALLOW_INSECURE=1 (l'agent loggue alors un WARNING à chaque boot).
            INSECURE="true"; shift ;;
        --binary)           AGENT_BINARY="$2";      shift 2 ;;
        --heartbeat)        HEARTBEAT_INTERVAL="$2"; shift 2 ;;
        --metrics)          METRICS_INTERVAL="$2";  shift 2 ;;
        --uninstall|--purge) MODE="uninstall";      shift ;;
        # --reenroll : TABLE RASE (supprime binaire, clés, secret, config,
        # état, sudoers, utilisateur ; conserve les logs) PUIS réinstall propre.
        --reenroll)         MODE="reenroll";        shift ;;
        -h|--help)
            echo "Usage:"
            echo "  install-agent.sh --server-url URL --machine-id ID --enrollment-token TOKEN [--server-public-key-file F] [--release-pubkey-file F]"
            echo "       --release-pubkey-file F : clé(s) publique(s) minisign de release → /etc/nexus/release.pub (auto-upgrade signé ; sans elle, l'auto-upgrade est refusé)"
            echo "       --script-signing-pubkey-file F : clé(s) publique(s) minisign de signature de script → /etc/nexus/script-signing.pub"
            echo "       --allow-remote-script : émet la ligne sudoers autorisant script.execute (OFF par défaut ; capacité root-RCE absente sinon)"
            echo "       --insecure : autorise un --server-url non-wss:// (NEXUS_ALLOW_INSECURE=1 ; WARNING à chaque boot) — DEV LOCAL uniquement"
            echo "  install-agent.sh --server-url URL --machine-id ID                                              # REFRESH sudoers+service (agent déjà enrôlé)"
            echo "  install-agent.sh --reenroll  --server-url URL --machine-id ID --enrollment-token TOKEN [...]   # TABLE RASE (sudoers/user/binaire, logs gardés) + réinstall"
            echo "  install-agent.sh --uninstall                                                                   # suppression complète"
            echo ""
            echo "  NB : la mise à jour 'self-upgrade' (depuis l'UI) ne remplace QUE le binaire."
            echo "       sudoers et service systemd ne sont (ré)écrits que par ce script —"
            echo "       à relancer si le sudoers a dérivé (ex. nouvelle commande whitelistée)."
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

# NEXUS-ENROLLMENT-001 — garde wss:// au moment de l'install (miroir de la garde
# agent), pour échouer ici plutôt que silencieusement au runtime. Un --server-url
# en clair (ws://, http://) n'est accepté qu'avec --insecure (dev local).
case "$SERVER_URL" in
    wss://*) ;;
    *)
        if [ "$INSECURE" != "true" ]; then
            error "--server-url doit utiliser wss:// (TLS obligatoire pour le bootstrap) : '$SERVER_URL'."
            error "Le token et la clé publique de l'agent transiteraient en clair. Utilisez wss://, ou --insecure pour le dev local uniquement."
            exit 1
        fi
        warn "Transport NON CHIFFRÉ accepté (--insecure) : '$SERVER_URL'. NEXUS_ALLOW_INSECURE=1 sera posé ; l'agent loggue un WARNING à chaque boot. Dev local uniquement."
        ;;
esac

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

# Ré-enrollement : TABLE RASE avant de réinstaller (sudoers/user/binaire inclus,
# logs conservés). Évite à la fois le deadlock shared.secret ET le sudoers
# obsolète (puisque tout est réécrit ensuite par l'install).
if [ "$MODE" = "reenroll" ]; then
    info "Ré-enrôlement : purge complète de l'agent (table rase, logs conservés)…"
    wipe_agent keep-logs
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

# === Exécution de script : règle volontairement ABSENTE de ce heredoc statique ===
# La règle d'exécution de script n'est émise qu'en opt-in (--allow-remote-script),
# appendée hors de ce bloc juste avant `visudo`. Quand off, la capacité root-RCE
# correspondante n'existe nulle part dans ce fichier.

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
# Bannière légale (security.set_login_banner) : /etc/issue + /etc/issue.net
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-banner-*.tmp /etc/issue
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-banner-*.tmp /etc/issue.net
# Core dumps off (security.disable_core_dumps)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-nocore-*.tmp /etc/security/limits.d/99-nexus-nocore.conf
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-coredump-*.tmp /etc/sysctl.d/99-nexus-coredump.conf
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/sysctl -p /etc/sysctl.d/99-nexus-coredump.conf
# Durcissement login.defs (security.harden_login_defs)
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /var/lib/nexus-agent/sec-logindefs-*.tmp /etc/login.defs

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

# === SSL cert scanning (NEXUS-AGENT-001 : prédicat ÉPINGLÉ, pas de queue ouverte) ===
# Racines FIGÉES + -maxdepth/-type/-name, SANS ` *` final → -exec/-fprintf/-execdir
# inappendables (plus de GTFOBins find -exec root-shell). Doit rester byte-identique
# aux args construits par ssl_scan.go listCandidateCertFiles. /etc/ssl/private RETIRÉ
# (clés privées). Pas de parens (sudoers ne les parse pas) : précédence find
# (-type f -name *.pem) OR (-type f -name *.crt), -maxdepth global.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/find /etc/letsencrypt/live /etc/ssl/certs/ssl-cert-snakeoil.pem /etc/nginx/ssl /etc/apache2/ssl /etc/haproxy/certs -maxdepth 4 -type f -name *.pem -o -type f -name *.crt
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

# === Opt-in script.execute : capacité root-RCE émise SEULEMENT si demandée ===
# Append hors du heredoc statique. Sans --allow-remote-script, le mot
# "nexus-script" n'apparaît NULLE PART dans le sudoers → `sudo /bin/bash
# nexus-script-*.sh` est refusé par sudo lui-même (commande hors whitelist).
# C'est une capacité RETIRÉE du système, pas un flag applicatif contournable.
if [ "$ALLOW_REMOTE_SCRIPT" = "true" ]; then
    printf '\n# === Scripts Nexus (opt-in --allow-remote-script ; scripts signés, vérifiés côté agent) ===\nnexus-agent ALL=(root) NOPASSWD: /bin/bash %s/nexus-script-*.sh\n' \
        "$AGENT_SCRIPT_DIR" >> "$SUDOERS_TEMP"
    warn "Exécution distante de script ACTIVÉE (--allow-remote-script) : capacité root-RCE émise dans le sudoers."
fi

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

# Refresh d'un agent déjà enrôlé, sans binaire fourni : on CONSERVE le binaire
# en place. C'est volontaire — ce mode sert à rafraîchir sudoers/service (que la
# self-upgrade ne peut pas mettre à jour) sans écraser/rétrograder le binaire que
# la self-upgrade a éventuellement installé.
if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -z "$AGENT_BINARY" ] && [ ! -f "./nexus-agent" ] && [ -f "$BIN_PATH" ]; then
    chown root:root "$BIN_PATH"
    chmod 755 "$BIN_PATH"
    ok "Refresh : binaire existant conservé ($BIN_PATH, $(du -h "$BIN_PATH" | cut -f1)) — géré par la self-upgrade."
else
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
fi

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

# Accept-list des clés publiques de release (vérification de l'auto-upgrade,
# indépendante du canal). root:root 0644 : seul root écrit, l'agent (non-root)
# la lit. Absente ⇒ l'agent refuse l'auto-upgrade (fail-closed), mais tourne
# normalement pour tout le reste. En REFRESH (identité locale présente, pas de
# --release-pubkey-file), le fichier existant est conservé tel quel ; un
# ré-enrôlement/uninstall fait table rase de $CONFIG_DIR et impose de le
# re-fournir.
RELEASE_PUBKEY_FILE="$CONFIG_DIR/release.pub"
if [ -n "${RELEASE_PUBKEY:-}" ]; then
    printf '%s\n' "$RELEASE_PUBKEY" > "$RELEASE_PUBKEY_FILE"
    chown root:root "$RELEASE_PUBKEY_FILE"
    chmod 644 "$RELEASE_PUBKEY_FILE"
fi

# Accept-list DÉDIÉE à la signature de script (verrou indépendant du canal pour
# script.execute). Même modèle que release.pub : root:root 0644 (world-readable →
# l'agent non-root la lit sans CAP_DAC_READ_SEARCH, donc indépendant d'AGENT-002).
# Clé distincte de la clé serveur et de la clé de release. Conservée en REFRESH,
# re-fournir sur reenroll/uninstall.
SCRIPT_SIGNING_PUBKEY_FILE="$CONFIG_DIR/script-signing.pub"
if [ -n "${SCRIPT_SIGNING_PUBKEY:-}" ]; then
    printf '%s\n' "$SCRIPT_SIGNING_PUBKEY" > "$SCRIPT_SIGNING_PUBKEY_FILE"
    chown root:root "$SCRIPT_SIGNING_PUBKEY_FILE"
    chmod 644 "$SCRIPT_SIGNING_PUBKEY_FILE"
fi

# NEXUS-CRYPTO-001 — sel par-install pour le chiffrement au repos de agent.key
# (machine-binding logiciel : HKDF(machine-id, sel)). Scope-split VOLONTAIRE :
# le sel vit dans $CONFIG_DIR (/etc/nexus), la clé dans $KEY_DIR (/var/lib/nexus/
# keys) → une exfil scopée d'un seul dir rate une moitié. root:nexus-agent 0640 :
# l'agent le lit par groupe (pas de sudo, pas de cap). Généré une seule fois et
# CONSERVÉ en refresh (sinon la clé existante deviendrait indéchiffrable) ;
# régénéré au --reenroll (table rase de $CONFIG_DIR → nouvelle identité, nouveau sel).
# LIMITE : un snapshot/backup disque complet contient sel + machine-id → la clé
# reste re-dérivable. Seul le TPM fermerait ce cas (non couvert ici).
KEY_SALT_FILE="$CONFIG_DIR/agent-keysalt"
if [ ! -f "$KEY_SALT_FILE" ]; then
    head -c 32 /dev/urandom | base64 > "$KEY_SALT_FILE"
    chown root:"$AGENT_GROUP" "$KEY_SALT_FILE"
    chmod 640 "$KEY_SALT_FILE"
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

# Transport en clair autorisé uniquement si --insecure (dev local). Écrit seulement
# quand actif → l'agent loggue alors un WARNING à chaque boot (cf. config.go).
if [ "$INSECURE" = "true" ]; then
    printf 'NEXUS_ALLOW_INSECURE=1\n' >> "$CONFIG_DIR/agent.env"
fi

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

# NEXUS-AGENT-002 — Capabilities Linux au strict minimum.
# Le process agent (non-root) n'a besoin d'AUCUNE capability ambiante : monitoring
# via /proc (lecture standard), fichiers via DAC, réseau en TCP sortant. Les
# opérations privilégiées passent par sudo (enfants root via setuid). Les lectures
# root légitimes (certs) ont un fallback `sudo cat` ciblé (ssl_scan.go), donc on
# n'a plus besoin de CAP_DAC_READ_SEARCH (override aveugle de DAC).
AmbientCapabilities=
# Drift-guard CIBLÉ : on retire du bounding set de TOUTE l'unité (process agent ET
# enfants sudo) les 2 capabilities d'attaque que l'agent ne doit JAMAIS détenir —
#  - CAP_DAC_READ_SEARCH : lecture de N'IMPORTE quel fichier en ignorant DAC
#    (court-circuitait le sudoers et aurait défait le chiffrement au repos de
#     CRYPTO-001) ;
#  - CAP_SYS_PTRACE : attache ptrace inter-process (lecture mémoire des daemons root).
# Syntaxe `~` = « toutes SAUF celles-ci » : les enfants sudo (apt/netplan/useradd…)
# conservent CHOWN/FOWNER/DAC_OVERRIDE/SETUID/SETGID… dont ils ont besoin. Un
# bounding set en allow-list (ex. CAP_NET_RAW seul) plafonnerait AUSSI les enfants
# sudo et casserait les actions privilégiées sur tout le parc.
CapabilityBoundingSet=~CAP_DAC_READ_SEARCH CAP_SYS_PTRACE

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
    echo -e "  ${GREEN}Rafraîchis :${NC} sudoers ($SUDOERS_FILE) + service systemd"
    echo "  (ce sont précisément les fichiers que la self-upgrade ne peut pas mettre à jour)"
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
