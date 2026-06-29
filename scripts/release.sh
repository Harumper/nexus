#!/usr/bin/env bash
#
# release.sh — Release d'agent Nexus en UNE commande, depuis TA machine de confiance.
#
#   Usage : ./release.sh vX.Y.Z
#
# Fait tout, sans autre intervention que le mot de passe de TA clé minisign :
#   1. (si besoin) crée + pousse le tag → déclenche le job CI `release-build`
#   2. attend que `release-build` ait produit l'artefact, puis le récupère (API GitLab)
#   3. vérifie le sha256 (refus net si mismatch — tu signes l'octet EXACT produit par la CI)
#   4. signe localement (minisign -S) — SEUL prompt : le mot de passe de ta clé
#   5. récupère VERSION (la version réelle gravée dans le binaire, = AGENT_VERSION CI)
#   6. publie nexus-agent + nexus-agent.minisig + VERSION dans /release sur la prod,
#      via le user CONFINÉ nexus-release (rsync --delay-updates = bascule atomique)
#
# La clé privée nexus-release.key ne quitte JAMAIS cette machine.
# Tout échec (artefact introuvable, sha mismatch, signature ratée, rsync KO) =
# message clair + exit non-zéro, AUCUNE publication partielle (le rsync est la
# dernière étape ; rien n'est poussé tant que tout le reste n'a pas réussi).

set -Eeuo pipefail

# =====================================================================
# CONFIG — à remplir UNE fois. Les secrets (token) : préférer l'env ou
# ~/.config/nexus-release.env (NON commité), pas en dur dans ce fichier versionné.
# =====================================================================
[ -f "$HOME/.config/nexus-release.env" ] && . "$HOME/.config/nexus-release.env"

GITLAB_URL="${GITLAB_URL:-https://gitlab.jsloiseau.net}"
PROJECT_ID="${PROJECT_ID:-39}"                      # ID numérique du projet GitLab (ou chemin url-encodé "loiseau%2Fnexus")
RELEASE_JOB="${RELEASE_JOB:-release-build}"         # nom du job CI qui produit l'artefact
GITLAB_TOKEN="${GITLAB_TOKEN:-}"                    # token GitLab scope read_api (env ou ~/.config/nexus-release.env)

RELEASE_KEY="${RELEASE_KEY:-$HOME/nexus-signing/nexus-release.key}"   # ta clé privée minisign (hors-ligne)

PROD_HOST="${PROD_HOST:-10.0.10.102}"              # hôte de prod (management)
PROD_RELEASE_USER="${PROD_RELEASE_USER:-nexus-release}"               # user confiné (rrsync -wo /docker_server/nexus/release/)
NEXUS_RELEASE_SSH_KEY="${NEXUS_RELEASE_SSH_KEY:-$HOME/.ssh/nexus-release}"  # clé SSH privée de nexus-release (sur CETTE machine)

PUSH_TAG="${PUSH_TAG:-1}"                           # 1 = crée/pousse le tag si absent ; 0 = suppose le tag déjà poussé
POLL_TIMEOUT="${POLL_TIMEOUT:-900}"                # secondes max d'attente de l'artefact CI
POLL_INTERVAL="${POLL_INTERVAL:-15}"
# =====================================================================

# ---- jolis logs + erreurs ----
c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_rst=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n' "$c_ylw" "$c_rst" "$*" >&2; }
die()  { printf '%s[ÉCHEC]%s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

WORKDIR=""
cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT
trap 'die "interrompu (ligne $LINENO)."' ERR

# ---- args ----
[ $# -eq 1 ] || die "usage : $0 vX.Y.Z"
TAG="$1"
case "$TAG" in
  v[0-9]*) : ;;
  *) die "le tag doit ressembler à vX.Y.Z (reçu : '$TAG')." ;;
esac

# ---- pré-vol config ----
[ -n "$GITLAB_TOKEN" ] || die "GITLAB_TOKEN vide. Mets un token scope read_api dans l'env ou ~/.config/nexus-release.env."
[ -f "$RELEASE_KEY" ]  || die "clé privée minisign introuvable : $RELEASE_KEY (configure RELEASE_KEY)."
[ -f "$NEXUS_RELEASE_SSH_KEY" ] || die "clé SSH nexus-release introuvable : $NEXUS_RELEASE_SSH_KEY (configure NEXUS_RELEASE_SSH_KEY)."
for bin in curl jq minisign rsync ssh git; do
  command -v "$bin" >/dev/null 2>&1 || die "outil requis manquant : $bin."
done

API="$GITLAB_URL/api/v4/projects/$PROJECT_ID"
auth=(--header "PRIVATE-TOKEN: $GITLAB_TOKEN")

# ---- 1. tag → déclenche release-build ----
if [ "$PUSH_TAG" = "1" ]; then
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    log "tag $TAG déjà présent localement."
  else
    log "création du tag $TAG sur HEAD ($(git rev-parse --short HEAD))."
    git tag "$TAG"
  fi
  log "push du tag $TAG (déclenche le pipeline CI)…"
  git push origin "$TAG" || die "git push du tag a échoué."
else
  log "PUSH_TAG=0 : on suppose que $TAG est déjà poussé et que release-build a tourné."
fi

# ---- 2. attendre + récupérer l'artefact de release-build pour ce tag ----
WORKDIR="$(mktemp -d)"
art_url() { printf '%s/jobs/artifacts/%s/raw/%s?job=%s' "$API" "$TAG" "$1" "$RELEASE_JOB"; }

log "attente de l'artefact '$RELEASE_JOB' pour $TAG (timeout ${POLL_TIMEOUT}s)…"
deadline=$(( $(date +%s) + POLL_TIMEOUT ))
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$(art_url nexus-agent.sha256)") || code=000
  case "$code" in
    200) log "artefact disponible." ; break ;;
    404) : ;;  # pas encore prêt (build en cours / pas encore réussi)
    401|403) die "API GitLab refuse l'accès (HTTP $code) — vérifie GITLAB_TOKEN (scope read_api) et PROJECT_ID." ;;
    *) warn "réponse inattendue HTTP $code, on réessaie…" ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || die "timeout : '$RELEASE_JOB' n'a pas produit d'artefact pour $TAG (pipeline en échec ? job non terminé ?)."
  sleep "$POLL_INTERVAL"
done

dl() { # dl <fichier-artefact> <dest>
  curl -fsSL "${auth[@]}" "$(art_url "$1")" -o "$2" \
    || die "téléchargement de l'artefact '$1' échoué."
}
log "téléchargement des artefacts…"
dl nexus-agent          "$WORKDIR/nexus-agent"
dl nexus-agent.sha256   "$WORKDIR/nexus-agent.sha256"
dl VERSION              "$WORKDIR/VERSION"

# ---- 3. vérifier le sha256 (sécurité : signer l'octet EXACT produit par la CI) ----
log "vérification du sha256…"
( cd "$WORKDIR" && sha256sum -c nexus-agent.sha256 ) \
  || die "sha256 MISMATCH — l'artefact téléchargé ne correspond pas au sha de la CI. Publication ABANDONNÉE."

VERSION_STR="$(tr -d '\r\n' < "$WORKDIR/VERSION")"
[ -n "$VERSION_STR" ] || die "VERSION vide dans l'artefact."
log "version (gravée dans le binaire par la CI) : $VERSION_STR"

# ---- 4. signer localement (SEUL prompt = mot de passe de ta clé) ----
log "signature locale (minisign) — saisis le mot de passe de ta clé :"
minisign -S -s "$RELEASE_KEY" -m "$WORKDIR/nexus-agent" \
  || die "signature minisign échouée (mauvais mot de passe ?)."
[ -f "$WORKDIR/nexus-agent.minisig" ] || die "signature absente après minisign -S."

# (sanity locale) si une clé publique est à côté de la privée, on re-vérifie
if [ -f "${RELEASE_KEY%.key}.pub" ]; then
  minisign -Vm "$WORKDIR/nexus-agent" -p "${RELEASE_KEY%.key}.pub" >/dev/null \
    && log "auto-vérif locale de la signature : OK." \
    || die "auto-vérif locale de la signature a échoué (clé pub/priv incohérentes ?)."
fi

# ---- 5/6. publier dans /release via le user confiné (bascule atomique) ----
# rrsync -wo mappe la destination ':/' sur /docker_server/nexus/release/.
# --delay-updates : rsync écrit des temporaires puis renomme TOUT à la fin →
# jamais de couple binaire/signature mi-écrit servi (équivaut au .tmp puis mv,
# sans avoir besoin d'un shell distant que le user confiné n'a pas).
log "publication dans /release sur $PROD_HOST via $PROD_RELEASE_USER (atomique)…"
rsync -a --delay-updates \
  -e "ssh -i $NEXUS_RELEASE_SSH_KEY -o StrictHostKeyChecking=accept-new" \
  "$WORKDIR/nexus-agent" "$WORKDIR/nexus-agent.minisig" "$WORKDIR/VERSION" \
  "$PROD_RELEASE_USER@$PROD_HOST:/" \
  || die "rsync vers $PROD_RELEASE_USER@$PROD_HOST a échoué — RIEN n'a été publié (bascule atomique non effectuée)."

log "${c_grn}Release $TAG publiée (version $VERSION_STR).${c_rst}"
log "Les agents la téléchargeront au prochain enrôlement/upgrade depuis /release."
