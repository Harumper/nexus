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
    error "This script must be run as root (sudo)."
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
        systemctl stop "$SERVICE_NAME" && ok "Service stopped."
    fi
    systemctl disable "$SERVICE_NAME" &>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE_NAME" &>/dev/null || true
    ok "systemd unit removed."

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
    ok "Binary removed: $BIN_PATH"

    # 3. Clés, shared secret, clé serveur, config, état/snapshots (+ logs si non conservés)
    rm -rf "$KEY_DIR" /opt/nexus/keys /var/lib/nexus /opt/nexus
    rm -rf "$CONFIG_DIR"
    rm -rf "$AGENT_SCRIPT_DIR"        # /var/lib/nexus-agent (snapshots/inbox/scripts/tempfiles)
    if [ "$keep_logs" = "keep-logs" ]; then
        ok "Keys, config, state and snapshots removed (logs kept)."
    else
        rm -rf "$LOG_DIR"
        ok "Keys, config, state, snapshots and logs removed."
    fi

    # 4. Sudoers (table rase — réécrit ensuite par l'install)
    rm -f /etc/sudoers.d/nexus-agent
    ok "Sudoers removed."

    # 5. Utilisateur système + retrait du groupe
    if id "$AGENT_USER" &>/dev/null; then
        gpasswd -d "$AGENT_USER" systemd-journal &>/dev/null || true
        userdel "$AGENT_USER" &>/dev/null && ok "User '$AGENT_USER' removed." || \
            warn "Could not remove user '$AGENT_USER' (process still running?)."
    fi
}

# do_uninstall : suppression complète (--purge), logs inclus.
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
                error "Public key file not found: $2"
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
                error "Release public key file not found: $2"
                exit 1
            fi
            RELEASE_PUBKEY="$(cat "$2")"
            shift 2 ;;
        --script-signing-pubkey-file)
            # Accept-list minisign DÉDIÉE à la signature de script (distincte de
            # la clé serveur et de la clé de release). Privée hors-ligne côté
            # opérateur ; seule la moitié publique est déposée ici.
            if [ ! -f "$2" ]; then
                error "Script signing public key file not found: $2"
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
    read -p "Nexus server URL (e.g. ws://nexus:26031/ws/agent): " SERVER_URL
fi

if [ -z "$MACHINE_ID" ]; then
    read -p "Machine ID: " MACHINE_ID
fi

# Le token n'est requis QUE si l'agent n'a pas déjà une identité locale ENRÔLÉE.
# Marqueur v2 = fichier "enrolled" (cf agent keystore.go MarkEnrolled/IsEnrolled : c'est
# LUI qui fait sauter l'enrôlement au boot) ; on teste aussi agent.key par robustesse
# (identité résiduelle même si le marqueur manque). ⚠ NE PAS tester shared.secret : c'est
# un vestige v1, PLUS écrit en v2 (la clé de canal est dérivée par handshake ECDHE, jamais
# persistée) → s'en servir rendait cette détection TOUJOURS fausse. Pour un simple
# rafraîchissement sudoers/binaire sur une machine déjà enrôlée, l'agent réutilise ses
# clés existantes et ne ré-enrôle pas.
HAS_LOCAL_IDENTITY=false
if { [ -f "$KEY_DIR/enrolled" ] || [ -f "$KEY_DIR/agent.key" ]; } && [ "$MODE" != "reenroll" ]; then
    HAS_LOCAL_IDENTITY=true
fi

# Garde-fou anti-deadlock (refus explicite, jamais de purge auto) : un --enrollment-token
# fourni alors qu'une identité locale existe DÉJÀ est un piège. L'agent saute l'enrollment
# tant que le marqueur "enrolled" est présent → il IGNORE le token et garde son ancienne
# identité ; si celle-ci a été invalidée côté serveur (machine supprimée/recréée/ré-enrôlée),
# le boot part en boucle "Session handshake failed: unexpected handshake response type: error".
# On refuse plutôt que de démarrer dans le mur. La purge d'identité est DESTRUCTRICE : elle
# n'est jamais automatique, elle exige le geste délibéré --reenroll (que le bouton
# « Ré-enrôler » de l'UI ajoute déjà). On NE compare PAS le machine-id : "token + identité"
# suffit, et un refus est non-destructeur (aucune primitive de purge exploitable).
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

# NEXUS-ENROLLMENT-001 — garde wss:// au moment de l'install (miroir de la garde
# agent), pour échouer ici plutôt que silencieusement au runtime. Un --server-url
# en clair (ws://, http://) n'est accepté qu'avec --insecure (dev local).
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
    ENROLLMENT_TOKEN="__refresh__"   # placeholder, non utilisé (l'agent saute l'enrollement)
fi

# PINNING STRICT : la clé publique du serveur est obligatoire pour un (ré-)enrollement.
# En refresh (identité locale présente), la clé existante dans $CONFIG_DIR est conservée.
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

# ===================== 0. Arrêter l'agent s'il tourne déjà (re-install) =====================

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Agent currently running, stopping before reinstall..."
    systemctl stop "$SERVICE_NAME"
    ok "Agent stopped."
fi

# Ré-enrollement : TABLE RASE avant de réinstaller (sudoers/user/binaire inclus,
# logs conservés). Évite à la fois le deadlock shared.secret ET le sudoers
# obsolète (puisque tout est réécrit ensuite par l'install).
if [ "$MODE" = "reenroll" ]; then
    info "Re-enrollment: full agent purge (clean wipe, logs kept)…"
    wipe_agent keep-logs
fi

# ===================== 1. Créer l'utilisateur système =====================

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

# Ajouter au groupe systemd-journal pour la lecture des logs via journalctl
# (evite d'avoir a whitelister journalctl dans sudoers)
if getent group systemd-journal > /dev/null; then
    usermod -a -G systemd-journal "$AGENT_USER"
    ok "Added to the systemd-journal group for log reading."
fi

# ===================== 2. Configurer sudoers (commandes privilégiées) =====================

info "Configuring sudo privileges for '$AGENT_USER'..."

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

# === NEXUS-AGENT-009 : posture d'environnement épinglée pour ce drop-in ===
# Le confinement de l'agent ne doit PAS dépendre d'un invariant tenu dans
# /etc/sudoers (qu'un opérateur peut légitimement personnaliser). On scope donc
# env_reset + secure_path à nexus-agent ici. Aucun env_keep dangereux
# (LD_PRELOAD/BASH_ENV/ENV) n'est jamais ajouté — un .so injecté ou un BASH_ENV
# sourcé en root via `sudo /bin/bash nexus-script-*.sh` resterait bloqué même si
# le global /etc/sudoers était affaibli.
Defaults:nexus-agent env_reset
Defaults:nexus-agent secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# === Package management (APT) ===
# === Self-introspection (lecture sudoers pour detecter drift) ===
nexus-agent ALL=(root) NOPASSWD: /bin/cat /etc/sudoers.d/nexus-agent

# === APT ===
# NEXUS-AGENT-010 — PÉRIMÈTRE de NOEXEC (à ne pas surinterpréter) : NOEXEC n'est
# PAS un pilier de confinement général. Il ne s'applique QU'aux lignes
# install/remove des gestionnaires de paquets (apt-get/dnf/yum, ~6 lignes), comme
# BACKSTOP ciblé du wildcard de noms de paquets : il empêche qu'un paquet/hook
# déclenche l'exécution d'un sous-processus arbitraire (style `-o
# DPkg::Pre-Invoke=`). Les ~44 autres lignes ne reposent PAS sur NOEXEC mais sur
# des chemins fixes, des arguments EXACTS, le privhelper compilé, et les regex de
# validation côté Go. NOEXEC est un filet sur une seule primitive, pas la garantie
# d'ensemble.
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

# === Privhelper compilé (NEXUS-AGENT-003/008 : wrapper root du binaire agent) ===
# Le binaire agent, invoqué `privhelper <op>`, exécute en root des opérations
# privilégiées STRICTEMENT validées en Go (création user avec `--`, écritures avec
# realpath + dest littérale) — remplace les anciennes lignes `useradd *` /
# `install … */…*` exploitables. Aucun shell/interpréteur invocable (binaire
# compilé root:root 0755). Le `*` ici porte sur les args, validés par le binaire.
nexus-agent ALL=(root) NOPASSWD: /usr/local/bin/nexus-agent privhelper *

# === Exécution de script : règle volontairement ABSENTE de ce heredoc statique ===
# La règle d'exécution de script n'est émise qu'en opt-in (--allow-remote-script),
# appendée hors de ce bloc juste avant `visudo`. Quand off, la capacité root-RCE
# correspondante n'existe nulle part dans ce fichier.

# === Reboot ===
nexus-agent ALL=(root) NOPASSWD: /usr/bin/systemctl reboot

# === Services systemd (start/stop/restart/reload/enable/disable) ===
# NEXUS-AGENT-006 — plus de `systemctl <verb> *` brut en sudoers (le blocklist
# `systemctl stop ssh*` se contournait par insertion d'option :
# `systemctl stop --no-ask-password ssh` matchait `stop *` mais pas la négation).
# Tout le contrôle de service passe par le privhelper compilé (déjà autorisé plus
# haut : `nexus-agent privhelper *`), qui canonicalise verbe+unité et refuse en
# code les options injectées et les unités protégées (ssh/sshd/nexus-agent). La
# protection ne dépend donc plus d'un motif sudoers option-sensible.

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
# NEXUS-AGENT-008 : l'écriture du drop-in sshd passe par `privhelper install-sshd`
# (source realpath-validée sous /var/lib/nexus-agent/, dest FIXE) — la ligne
# `install … /var/lib/nexus-agent/* …` à wildcard source est retirée.
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
# SELF-UPGRADE-005 (watchdog-revert) : snapshot du binaire courant en .prev avant
# écrasement, et restauration .prev → binaire si l'upgrade ne confirme pas. Chemins
# FIXES des deux côtés.
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 755 /usr/local/bin/nexus-agent /var/lib/nexus-agent/nexus-agent.prev
nexus-agent ALL=(root) NOPASSWD: /usr/bin/install -m 755 /var/lib/nexus-agent/nexus-agent.prev /usr/local/bin/nexus-agent

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
# NEXUS-AGENT-008 : l'écriture netplan passe par `privhelper install-netplan`
# (src realpath sous staging + dst *.yaml DIRECTEMENT sous /etc/netplan, sans
# traversal) — la ligne `install … /etc/netplan/*.yaml` (dest wildcard) est retirée.

# === Users Linux + SSH keys ===
# NEXUS-AGENT-003 : la création d'utilisateur passe par `privhelper useradd`
# (login validé + `--` → pas de `-o -u 0`) — les lignes `useradd *` sont retirées.
# NEXUS-AGENT-008 : .ssh + authorized_keys passent par `privhelper install-authkeys`
# (home résolu par getent, dest dérivée non globée) — les lignes `install … /home/*`
# / `/root/*` sont retirées.
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/userdel -r *
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/gpasswd -a * sudo
nexus-agent ALL=(root) NOPASSWD: /usr/sbin/gpasswd -d * sudo
nexus-agent ALL=(root) NOPASSWD: /bin/cat /home/*/.ssh/authorized_keys
nexus-agent ALL=(root) NOPASSWD: /bin/cat /root/.ssh/authorized_keys
SUDOERS

# === Opt-in script.execute : capacité root-RCE émise SEULEMENT si demandée ===
# Append hors du heredoc statique. Sans --allow-remote-script, le mot
# "nexus-script" n'apparaît NULLE PART dans le sudoers → `sudo /bin/bash
# nexus-script-*.sh` est refusé par sudo lui-même (commande hors whitelist).
# C'est une capacité RETIRÉE du système, pas un flag applicatif contournable.
if [ "$ALLOW_REMOTE_SCRIPT" = "true" ]; then
    printf '\n# === Scripts Nexus (opt-in --allow-remote-script ; scripts signés, vérifiés côté agent) ===\nnexus-agent ALL=(root) NOPASSWD: /bin/bash %s/nexus-script-*.sh\n' \
        "$AGENT_SCRIPT_DIR" >> "$SUDOERS_TEMP"
    warn "Remote script execution ENABLED (--allow-remote-script): root-RCE capability emitted in the sudoers."
fi

# Valider la syntaxe AVANT d'appliquer
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

# ===================== 3. Installer le binaire =====================

info "Installing the binary..."

# Refresh d'un agent déjà enrôlé, sans binaire fourni : on CONSERVE le binaire
# en place. C'est volontaire — ce mode sert à rafraîchir sudoers/service (que la
# self-upgrade ne peut pas mettre à jour) sans écraser/rétrograder le binaire que
# la self-upgrade a éventuellement installé.
if [ "$HAS_LOCAL_IDENTITY" = true ] && [ -z "$AGENT_BINARY" ] && [ ! -f "./nexus-agent" ] && [ -f "$BIN_PATH" ]; then
    chown root:root "$BIN_PATH"
    chmod 755 "$BIN_PATH"
    ok "Refresh: existing binary kept ($BIN_PATH, $(du -h "$BIN_PATH" | cut -f1)) — managed by self-upgrade."
else
    if [ -n "$AGENT_BINARY" ] && [ -f "$AGENT_BINARY" ]; then
        # Skip cp if source and destination are the same file (cas ou le binaire
        # a ete telecharge directement dans $BIN_PATH avant l'install)
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
        # Essayer d'extraire depuis l'image Docker
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

# ===================== 4. Fichier de configuration =====================

info "Creating the configuration..."

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
# normalement pour tout le reste.
#
# Design A : la clé est en général fournie par la commande de bootstrap (le
# backend embarque NEXUS_RELEASE_PUBKEY) → posée à l'install ET au reenroll
# (qui purge $CONFIG_DIR, donc le fichier n'existe pas → on l'écrit).
# RÈGLE « ne pas écraser un pin existant » : si une release.pub est DÉJÀ présente
# (ex. déposée hors-bande par un opérateur haute-assurance), on ne l'écrase PAS,
# même si --release-pubkey-file est fourni. Pour la changer : la supprimer puis
# réinstaller, ou --reenroll (table rase de $CONFIG_DIR).
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

ok "Configuration: $CONFIG_DIR/agent.env"
echo "  Hostname : $HOSTNAME_DETECTED"
echo "  IPs      : $IPS_DETECTED"

# ===================== 5. Service systemd =====================

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

ok "systemd service installed: ${SERVICE_NAME}.service"

# ===================== 6. Démarrer =====================

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

    # Afficher les premières lignes de log
    journalctl -u "$SERVICE_NAME" --no-pager -n 10 2>/dev/null || true
else
    error "The agent did not start."
    journalctl -u "$SERVICE_NAME" --no-pager -n 20 2>/dev/null || true
    exit 1
fi
