#!/usr/bin/env bash
#
# nexus-release — APPROBATION + publication d'une release d'agent Nexus.
#
# Modèle « approbation de release » (cf. Android OTA / CalyxOS) : la manutention
# (récupération, vérif, signature, publication) est AUTOMATISÉE ; l'humain
# APPROUVE en connaissance de cause (il voit la version + le SHA256 exact qu'il
# s'apprête à signer, et peut refuser) ; l'acte est TRACÉ dans un journal local.
#
# Tourne depuis N'IMPORTE OÙ (aucune opération Git, pas besoin du dépôt).
# La clé privée minisign ne quitte JAMAIS cette machine.
#
#   Usage : ./nexus-release.sh approve vX.Y.Z      (ou : ./nexus-release.sh vX.Y.Z)
#
# WORKFLOW :
#   1. git tag vX.Y.Z && git push origin vX.Y.Z      (ou tag via l'UI GitLab)
#   2. attendre que le job CI `release-build` ait fini pour ce tag
#   3. ./nexus-release.sh approve vX.Y.Z
#        → récupère l'artefact, AFFICHE version + SHA256, demande ton approbation,
#          tu saisis le mot de passe de la clé, c'est signé et publié, c'est journalisé.
#
# Ce que fait le script :
#   1. récupère l'artefact nexus-agent du job release-build de CE tag (API GitLab)
#   2. vérifie le sha256 (refuse net si mismatch — tu signes l'octet EXACT de la CI)
#   3. AFFICHE version + artefact + SHA256, demande CONFIRMATION explicite (y/N)
#   4. signe localement (minisign -S) — seul prompt crypto : ton mot de passe
#   5. publie nexus-agent + nexus-agent.minisig + VERSION dans /release sur la prod,
#      via le user CONFINÉ nexus-release (rsync --delay-updates = bascule atomique)
#   6. journalise l'acte (horodatage, version, sha256, succès/échec)
#
# Toute erreur (artefact introuvable, hash mismatch, refus, signature ratée, upload
# KO) = message clair + exit non-zéro + entrée FAIL au journal, JAMAIS de publication
# partielle (la publication est la dernière étape ; rien n'est poussé avant).

set -Eeuo pipefail

# =====================================================================
# CONFIG — à remplir UNE fois. Secret (token) : préférer ~/.config/nexus-release.env
# (NON commité) ou l'env, pas en dur dans ce fichier.
# =====================================================================
[ -f "$HOME/.config/nexus-release.env" ] && . "$HOME/.config/nexus-release.env"

GITLAB_URL="${GITLAB_URL:-https://gitlab.jsloiseau.net}"
PROJECT_ID="${PROJECT_ID:-39}"                     # ID numérique du projet (ou chemin url-encodé)
RELEASE_JOB="${RELEASE_JOB:-release-build}"
GITLAB_TOKEN="${GITLAB_TOKEN:-}"                   # token scope read_api

RELEASE_KEY="${RELEASE_KEY:-$HOME/nexus-signing/nexus-release.key}"          # clé privée minisign (hors-ligne)
NEXUS_RELEASE_SSH_KEY="${NEXUS_RELEASE_SSH_KEY:-$HOME/.ssh/nexus-release}"   # clé SSH de l'user confiné

PROD_HOST="${PROD_HOST:-10.0.10.102}"
PROD_RELEASE_USER="${PROD_RELEASE_USER:-nexus-release}"

POLL_TIMEOUT="${POLL_TIMEOUT:-600}"                # attente max de l'artefact (release-build pas encore fini)
POLL_INTERVAL="${POLL_INTERVAL:-15}"

LOG_DIR="${LOG_DIR:-$HOME/.local/share/nexus-release}"
LOG_FILE="$LOG_DIR/releases.log"
# =====================================================================

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_bld=$'\033[1m'; c_rst=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_ylw" "$c_rst" "$*" >&2; }

# état pour la journalisation (rempli au fil de l'eau)
TAG=""; VERSION_STR=""; ART_SHA=""
AUDITED=0
audit() { # audit <STATUS> <detail>
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s\t%s\tversion=%s\tsha256=%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${TAG:--}" "${VERSION_STR:--}" "${ART_SHA:--}" "$1" "${2:-}" \
    >> "$LOG_FILE" 2>/dev/null || true
  AUDITED=1
}
die() { printf '%s[ÉCHEC]%s %s\n' "$c_red" "$c_rst" "$*" >&2; [ "$AUDITED" = 1 ] || audit FAIL "$*"; exit 1; }
trap 'die "erreur inattendue (ligne $LINENO, code $?)"' ERR

WORKDIR=""
cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ---- args : [approve] vX.Y.Z ----
[ "${1:-}" = "approve" ] && shift
[ $# -eq 1 ] || die "usage : $0 approve vX.Y.Z   (ou : $0 vX.Y.Z)"
TAG="$1"
case "$TAG" in v[0-9]*) : ;; *) die "le tag doit ressembler à vX.Y.Z (reçu : '$TAG')." ;; esac

# ---- préflight ----
[ -n "$GITLAB_TOKEN" ] || die "GITLAB_TOKEN vide. Mets un token read_api dans l'env ou ~/.config/nexus-release.env."
[ -f "$RELEASE_KEY" ]  || die "clé privée minisign introuvable : $RELEASE_KEY (config RELEASE_KEY)."
[ -f "$NEXUS_RELEASE_SSH_KEY" ] || die "clé SSH nexus-release introuvable : $NEXUS_RELEASE_SSH_KEY (config NEXUS_RELEASE_SSH_KEY)."
for b in curl minisign rsync ssh sha256sum awk; do command -v "$b" >/dev/null 2>&1 || die "outil requis manquant : $b."; done

API="$GITLAB_URL/api/v4/projects/$PROJECT_ID"
auth=(--header "PRIVATE-TOKEN: $GITLAB_TOKEN")
art_url() { printf '%s/jobs/artifacts/%s/raw/%s?job=%s' "$API" "$TAG" "$1" "$RELEASE_JOB"; }

# ---- 1. récupérer l'artefact (attente bornée si release-build pas encore fini) ----
WORKDIR="$(mktemp -d)"
log "recherche de l'artefact '$RELEASE_JOB' pour $TAG (timeout ${POLL_TIMEOUT}s)…"
deadline=$(( $(date +%s) + POLL_TIMEOUT ))
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$(art_url nexus-agent.sha256)") || code=000
  case "$code" in
    200) break ;;
    404) : ;;
    401|403) die "API GitLab refuse l'accès (HTTP $code) — vérifie GITLAB_TOKEN (read_api) et PROJECT_ID." ;;
    *) warn "réponse inattendue HTTP $code, nouvel essai…" ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || die "timeout : pas d'artefact pour $TAG (tag poussé ? release-build terminé/réussi ?)."
  sleep "$POLL_INTERVAL"
done
dl() { curl -fsSL "${auth[@]}" "$(art_url "$1")" -o "$2" || die "téléchargement de l'artefact '$1' échoué."; }
log "téléchargement…"
dl nexus-agent        "$WORKDIR/nexus-agent"
dl nexus-agent.sha256 "$WORKDIR/nexus-agent.sha256"
dl VERSION            "$WORKDIR/VERSION"

# ---- 2. vérifier le sha256 (intégrité : artefact == build CI) ----
( cd "$WORKDIR" && sha256sum -c nexus-agent.sha256 >/dev/null 2>&1 ) \
  || die "sha256 MISMATCH — l'artefact téléchargé ne correspond pas au sha de la CI. ABANDON."
ART_SHA="$(sha256sum "$WORKDIR/nexus-agent" | awk '{print $1}')"
VERSION_STR="$(tr -d '\r\n' < "$WORKDIR/VERSION")"
[ -n "$VERSION_STR" ] || die "VERSION vide dans l'artefact."

# ---- 3. APPROBATION ÉCLAIRÉE (humain) ----
size=$(wc -c < "$WORKDIR/nexus-agent" | tr -d ' ')
printf '\n%s──────── APPROBATION DE RELEASE ────────%s\n' "$c_bld" "$c_rst"
printf '  Tag            : %s\n' "$TAG"
printf '  Version (CI)   : %s\n' "$VERSION_STR"
printf '  Artefact       : nexus-agent (%s octets)\n' "$size"
printf '  SHA256         : %s%s%s\n' "$c_bld" "$ART_SHA" "$c_rst"
printf '  Publié vers    : %s@%s:/release/\n' "$PROD_RELEASE_USER" "$PROD_HOST"
printf '%s────────────────────────────────────────%s\n' "$c_bld" "$c_rst"
printf 'Vérifie que ce SHA256 correspond bien à la release attendue.\n'
reply=""
read -r -p "Approuver et signer cette release ? (y/N) " reply < /dev/tty || true
case "$reply" in
  y|Y|yes|YES|oui|OUI) : ;;
  *) audit REFUSED "non approuvé à la confirmation"; die "release NON approuvée — rien n'a été signé ni publié." ;;
esac

# ---- 4. signature locale (seul prompt crypto : ton mot de passe) ----
log "signature locale (minisign) — saisis le mot de passe de ta clé :"
minisign -S -s "$RELEASE_KEY" -m "$WORKDIR/nexus-agent" \
  || die "signature minisign échouée (mauvais mot de passe ?)."
[ -f "$WORKDIR/nexus-agent.minisig" ] || die "signature absente après minisign -S."
# auto-vérif locale si la clé publique est à côté de la privée
if [ -f "${RELEASE_KEY%.key}.pub" ]; then
  minisign -Vm "$WORKDIR/nexus-agent" -p "${RELEASE_KEY%.key}.pub" >/dev/null \
    && log "auto-vérif de la signature : OK." \
    || die "auto-vérif de la signature a échoué (clés pub/priv incohérentes ?)."
fi

# ---- 5. publication atomique dans /release via l'user confiné ----
# rrsync -wo mappe ':/' sur /docker_server/nexus/release/. --delay-updates :
# rsync écrit des temporaires puis renomme TOUT à la fin → jamais de couple mi-écrit.
log "publication dans /release sur $PROD_HOST via $PROD_RELEASE_USER (atomique)…"
rsync -a --delay-updates \
  -e "ssh -i $NEXUS_RELEASE_SSH_KEY -o StrictHostKeyChecking=accept-new" \
  "$WORKDIR/nexus-agent" "$WORKDIR/nexus-agent.minisig" "$WORKDIR/VERSION" \
  "$PROD_RELEASE_USER@$PROD_HOST:/" \
  || die "rsync vers $PROD_RELEASE_USER@$PROD_HOST a échoué — RIEN n'a été publié (bascule atomique non effectuée)."

# ---- 6. journaliser le succès ----
audit OK "publiée"
log "${c_grn}Release $TAG publiée (version $VERSION_STR).${c_rst}"
log "Journal : $LOG_FILE"
log "Les agents la téléchargeront au prochain enrôlement/upgrade depuis /release."
