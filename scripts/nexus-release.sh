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
#   Usage :
#     ./nexus-release.sh approve            → approuve le DERNIER build de master
#     ./nexus-release.sh approve <ref>      → approuve un ref précis (tag ou branche)
#     (le mot-clé 'approve' est optionnel : ./nexus-release.sh [<ref>] marche aussi)
#
# PAS besoin de poser un tag par release : le CI build master automatiquement et
# génère la version (job `version` → X.Y.Z+agent.<rev>). Le script lit le DERNIER
# artefact `release-build` via l'API GitLab. (Poser un tag vX.Y.Z reste possible
# pour monter le X.Y.Z sémantique, et s'utilise via `approve vX.Y.Z`.)
#
# WORKFLOW :
#   1. (le CI a buildé master tout seul — rien à faire de ton côté)
#   2. ./nexus-release.sh approve
#        → récupère le dernier binaire, AFFICHE version + SHA256, tu approuves,
#          tu saisis le mot de passe de la clé, c'est signé + publié + journalisé.
#
# Ce que fait le script :
#   1. récupère l'artefact nexus-agent du DERNIER release-build du ref (API GitLab)
#   2. vérifie le sha256 (refuse net si mismatch — tu signes l'octet EXACT de la CI)
#   3. AFFICHE version + artefact + SHA256, demande CONFIRMATION explicite (y/N)
#   4. signe localement (minisign -S) — seul prompt crypto : ton mot de passe
#   5. publie nexus-agent + nexus-agent.minisig + VERSION dans /release sur la prod,
#      via le user CONFINÉ nexus-release (rsync --delay-updates = bascule atomique)
#   6. journalise l'acte (horodatage, ref, version, sha256, succès/échec)
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
PROJECT_ID="${PROJECT_ID:-loiseau%2Fnexus}"        # chemin url-encodé (ou ID numérique, ex. 39)
RELEASE_JOB="${RELEASE_JOB:-release-build}"
GITLAB_TOKEN="${GITLAB_TOKEN:-}"                   # token scope read_api

RELEASE_KEY="${RELEASE_KEY:-$HOME/nexus-signing/nexus-release.key}"          # clé privée minisign (hors-ligne)
NEXUS_RELEASE_SSH_KEY="${NEXUS_RELEASE_SSH_KEY:-$HOME/.ssh/nexus-release}"   # clé SSH de l'user confiné

PROD_HOST="${PROD_HOST:-10.0.10.102}"
PROD_RELEASE_USER="${PROD_RELEASE_USER:-nexus-release}"

DEFAULT_REF="${DEFAULT_REF:-master}"               # ref lu par défaut (dernier build)
POLL_TIMEOUT="${POLL_TIMEOUT:-600}"                # attente max de l'artefact (release-build pas encore fini)
POLL_INTERVAL="${POLL_INTERVAL:-15}"

LOG_DIR="${LOG_DIR:-$HOME/.local/share/nexus-release}"
LOG_FILE="$LOG_DIR/releases.log"
# =====================================================================

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_bld=$'\033[1m'; c_rst=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_ylw" "$c_rst" "$*" >&2; }

# état pour la journalisation (rempli au fil de l'eau)
REF=""; VERSION_STR=""; ART_SHA=""
AUDITED=0
audit() { # audit <STATUS> <detail>
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s\tref=%s\tversion=%s\tsha256=%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${REF:--}" "${VERSION_STR:--}" "${ART_SHA:--}" "$1" "${2:-}" \
    >> "$LOG_FILE" 2>/dev/null || true
  AUDITED=1
}
die() { printf '%s[ÉCHEC]%s %s\n' "$c_red" "$c_rst" "$*" >&2; [ "$AUDITED" = 1 ] || audit FAIL "$*"; exit 1; }
trap 'die "erreur inattendue (ligne $LINENO, code $?)"' ERR

WORKDIR=""
cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ---- args : [approve] [<ref>]   (ref défaut = master) ----
[ "${1:-}" = "approve" ] && shift
REF="${1:-$DEFAULT_REF}"
[ -n "$REF" ] || die "ref vide."

# ---- préflight ----
[ -n "$GITLAB_TOKEN" ] || die "GITLAB_TOKEN vide. Mets un token read_api dans l'env ou ~/.config/nexus-release.env."
[ -f "$RELEASE_KEY" ]  || die "clé privée minisign introuvable : $RELEASE_KEY (config RELEASE_KEY)."
[ -f "$NEXUS_RELEASE_SSH_KEY" ] || die "clé SSH nexus-release introuvable : $NEXUS_RELEASE_SSH_KEY (config NEXUS_RELEASE_SSH_KEY)."
for b in curl minisign rsync ssh sha256sum awk; do command -v "$b" >/dev/null 2>&1 || die "outil requis manquant : $b."; done

API="$GITLAB_URL/api/v4/projects/$PROJECT_ID"
auth=(--header "PRIVATE-TOKEN: $GITLAB_TOKEN")
art_url() { printf '%s/jobs/artifacts/%s/raw/%s?job=%s' "$API" "$REF" "$1" "$RELEASE_JOB"; }

# ---- 1. récupérer le DERNIER artefact release-build du ref (attente bornée) ----
WORKDIR="$(mktemp -d)"
log "recherche du dernier artefact '$RELEASE_JOB' sur '$REF' (timeout ${POLL_TIMEOUT}s)…"
deadline=$(( $(date +%s) + POLL_TIMEOUT ))
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$(art_url nexus-agent.sha256)") || code=000
  case "$code" in
    200) log "artefact disponible." ; break ;;
    401|403) die "API GitLab refuse l'accès (HTTP $code) — vérifie GITLAB_TOKEN (read_api) et PROJECT_ID." ;;
    404) warn "pas encore prêt (HTTP 404) — '$RELEASE_JOB' pas (encore) réussi sur '$REF'. Reste $(( deadline - $(date +%s) ))s." ;;
    *) warn "réponse inattendue HTTP $code, nouvel essai…" ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || die "timeout : pas d'artefact '$RELEASE_JOB' sur '$REF' (pipeline réussi ? bon ref/projet/token ?)."
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
printf '  Source (ref)   : %s\n' "$REF"
printf '  Version (CI)   : %s\n' "$VERSION_STR"
printf '  Artefact       : nexus-agent (%s octets)\n' "$size"
printf '  SHA256         : %s%s%s\n' "$c_bld" "$ART_SHA" "$c_rst"
printf '  Publié vers    : %s@%s:/release/\n' "$PROD_RELEASE_USER" "$PROD_HOST"
printf '%s────────────────────────────────────────%s\n' "$c_bld" "$c_rst"
printf 'Vérifie que cette version + ce SHA256 correspondent à la release attendue.\n'
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
log "${c_grn}Release publiée — version $VERSION_STR (depuis $REF).${c_rst}"
log "Journal : $LOG_FILE"
log "Les agents la téléchargeront au prochain enrôlement/upgrade depuis /release."
