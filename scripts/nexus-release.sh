#!/usr/bin/env bash
#
# nexus-release — PROPOSE un numéro de version, puis APPROUVE+publie une release signée.
#
# Moindre privilège : cette machine (signature) n'a que READ_API sur GitLab. Elle
# NE crée PAS de tag (pas de token api, pas de push git). La création du tag est
# TON geste délibéré dans l'UI GitLab. La clé privée minisign ne quitte JAMAIS
# cette machine.
#
#   Usage :
#     ./nexus-release.sh                 → PROPOSE le prochain numéro (lecture seule)
#     ./nexus-release.sh approve vX.Y.Z  → approuve + signe + publie CE tag
#     (./nexus-release.sh vX.Y.Z marche aussi ; 'approve' est optionnel)
#
# WORKFLOW (2 invocations, le tag au milieu = ton geste) :
#   1. ./nexus-release.sh                         → te propose vX.Y.Z + le lien UI
#   2. crée le tag vX.Y.Z dans GitLab (UI, depuis master) → déclenche release-build
#   3. ./nexus-release.sh approve vX.Y.Z          → attend l'artefact, approbation,
#                                                   mot de passe, signe, publie, journalise
#
# Garde-fous (mode approve) : format strict vX.Y.Z ; le tag doit EXISTER ; et il doit
# être le PLUS RÉCENT (aucun tag strictement supérieur) — sinon refus (anti-downgrade,
# cohérent avec l'agent qui refuse les downgrades). Toute erreur = message clair +
# exit non-zéro + entrée FAIL au journal, jamais de publication partielle.

set -Eeuo pipefail

# =====================================================================
# CONFIG — à remplir UNE fois. Token : ~/.config/nexus-release.env (NON commité) ou env.
# =====================================================================
[ -f "$HOME/.config/nexus-release.env" ] && . "$HOME/.config/nexus-release.env"

GITLAB_URL="${GITLAB_URL:-https://gitlab.jsloiseau.net}"
PROJECT_ID="${PROJECT_ID:-loiseau%2Fnexus}"          # API : chemin url-encodé (ou ID, ex. 39)
GITLAB_PROJECT_PATH="${GITLAB_PROJECT_PATH:-loiseau/nexus}"   # lien UI de création de tag
RELEASE_JOB="${RELEASE_JOB:-release-build}"
GITLAB_TOKEN="${GITLAB_TOKEN:-}"                     # token scope READ_API (lecture seule)

RELEASE_KEY="${RELEASE_KEY:-$HOME/nexus-signing/nexus-release.key}"
NEXUS_RELEASE_SSH_KEY="${NEXUS_RELEASE_SSH_KEY:-$HOME/.ssh/nexus-release}"
PROD_HOST="${PROD_HOST:-10.0.10.102}"
PROD_RELEASE_USER="${PROD_RELEASE_USER:-nexus-release}"
SSH_STRICT="${SSH_STRICT:-accept-new}"               # 'accept-new' (TOFU 1er contact) ou 'yes' (refuse non épinglé)

POLL_TIMEOUT="${POLL_TIMEOUT:-600}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
LOG_DIR="${LOG_DIR:-$HOME/.local/share/nexus-release}"
LOG_FILE="$LOG_DIR/releases.log"
# =====================================================================

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_bld=$'\033[1m'; c_rst=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_ylw" "$c_rst" "$*" >&2; }

VER=""; VERSION_STR=""; ART_SHA=""; AUDITED=0
audit() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s\ttag=%s\tversion=%s\tsha256=%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${VER:--}" "${VERSION_STR:--}" "${ART_SHA:--}" "$1" "${2:-}" \
    >> "$LOG_FILE" 2>/dev/null || true
  AUDITED=1
}
die() { printf '%s[ÉCHEC]%s %s\n' "$c_red" "$c_rst" "$*" >&2; { [ "$AUDITED" = 0 ] && [ -n "$VER" ]; } && audit FAIL "$*"; exit 1; }
trap 'die "erreur inattendue (ligne $LINENO, code $?)"' ERR
WORKDIR=""; cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }; trap cleanup EXIT

API="$GITLAB_URL/api/v4/projects/$PROJECT_ID"
auth=(--header "PRIVATE-TOKEN: $GITLAB_TOKEN")
[ -n "$GITLAB_TOKEN" ] || die "GITLAB_TOKEN vide. Mets un token read_api dans l'env ou ~/.config/nexus-release.env."
command -v curl >/dev/null || die "curl manquant."

# Liste les tags propres vX.Y.Z (triés -V), erreurs API explicites.
fetch_tags() {
  local resp code body
  resp="$(curl -s -w $'\n%{http_code}' "${auth[@]}" "$API/repository/tags?per_page=100")" || die "appel API tags échoué."
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  case "$code" in
    200) : ;;
    401|403) die "API refuse l'accès (HTTP $code) — token read_api ?" ;;
    404) die "projet introuvable (HTTP 404) — PROJECT_ID ($PROJECT_ID) ?" ;;
    *) die "API tags : HTTP $code." ;;
  esac
  printf '%s' "$body" | grep -oE '"name":"[^"]*"' | sed -E 's/^"name":"//; s/"$//' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V
}
bump_patch() { local v="${1#v}" M m p; M="${v%%.*}"; v="${v#*.}"; m="${v%%.*}"; p="${v#*.}"; printf 'v%s.%s.%s' "$M" "$m" "$((p+1))"; }

# ---- args : [approve] [vX.Y.Z] ----
[ "${1:-}" = "approve" ] && shift
MODE="propose"; [ $# -ge 1 ] && { MODE="approve"; VER="$1"; }

# ============================ MODE PROPOSE ============================
if [ "$MODE" = "propose" ]; then
  log "lecture des tags (read_api)…"
  last="$(fetch_tags | tail -1 || true)"
  if [ -z "$last" ]; then proposed="v0.0.1"; last_disp="(aucune version propre)"; else proposed="$(bump_patch "$last")"; last_disp="$last"; fi
  printf '\n%s──────── PROPOSITION DE VERSION ────────%s\n' "$c_bld" "$c_rst"
  printf '  Dernière version : %s\n' "$last_disp"
  printf '  Proposé (patch)  : %s%s%s\n' "$c_bld" "$proposed" "$c_rst"
  printf '  (mineure → bump du milieu, ex. v0.1.0 ; majeure → v1.0.0)\n'
  printf '%s────────────────────────────────────────%s\n' "$c_bld" "$c_rst"
  printf 'Étapes :\n'
  printf '  1) crée le tag dans GitLab (depuis master) :\n'
  printf '       %s/%s/-/tags/new\n' "$GITLAB_URL" "$GITLAB_PROJECT_PATH"
  printf '  2) puis approuve + publie :\n'
  printf '       %s approve %s\n\n' "$0" "$proposed"
  exit 0
fi

# ============================ MODE APPROVE ============================
case "$VER" in v[0-9]*.[0-9]*.[0-9]*) : ;; *) die "format invalide '$VER' — attendu vX.Y.Z." ;; esac

# préflight signature/publication
[ -f "$RELEASE_KEY" ] || die "clé privée minisign introuvable : $RELEASE_KEY (config RELEASE_KEY)."
[ -f "$NEXUS_RELEASE_SSH_KEY" ] || die "clé SSH nexus-release introuvable : $NEXUS_RELEASE_SSH_KEY."
for b in minisign rsync ssh sha256sum awk stat; do command -v "$b" >/dev/null || die "outil requis manquant : $b."; done
# CORRECTIF B : permissions des clés (SSH ignore une clé trop ouverte → fallback password → échec)
for k in "$RELEASE_KEY" "$NEXUS_RELEASE_SSH_KEY"; do
  perms="$(stat -c '%a' "$k")" || die "impossible de lire les permissions de $k."
  [ $((8#$perms & 077)) -eq 0 ] || die "clé $k trop permissive ($perms) — SSH/minisign risquent de l'ignorer (fallback password → échec). Fais : chmod 600 $k"
done

# garde-fous tag : existe + le plus récent (anti-downgrade)
tags="$(fetch_tags)"
printf '%s\n' "$tags" | grep -qx "$VER" || die "le tag $VER n'existe pas dans GitLab — crée-le d'abord : $GITLAB_URL/$GITLAB_PROJECT_PATH/-/tags/new"
max="$(printf '%s\n%s\n' "$tags" "$VER" | sort -V | tail -1)"
[ "$max" = "$VER" ] || die "anti-downgrade : un tag plus récent existe ($max) — approuver $VER publierait une version antérieure."

# 1. récupérer l'artefact DE CE TAG (poll bavard)
WORKDIR="$(mktemp -d)"
art_url() { printf '%s/jobs/artifacts/%s/raw/%s?job=%s' "$API" "$VER" "$1" "$RELEASE_JOB"; }
log "attente de l'artefact '$RELEASE_JOB' du tag $VER (timeout ${POLL_TIMEOUT}s)…"
deadline=$(( $(date +%s) + POLL_TIMEOUT ))
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$(art_url nexus-agent.sha256)") || code=000
  case "$code" in
    200) log "artefact disponible." ; break ;;
    401|403) die "API refuse l'accès (HTTP $code) — token read_api ?" ;;
    404) warn "pas encore prêt (HTTP 404) — release-build pas (encore) réussi pour $VER. Reste $(( deadline - $(date +%s) ))s." ;;
    *) warn "réponse inattendue HTTP $code, nouvel essai…" ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || die "timeout : pas d'artefact pour $VER (release-build terminé/réussi ?)."
  sleep "$POLL_INTERVAL"
done
dl() { curl -fsSL "${auth[@]}" "$(art_url "$1")" -o "$2" || die "téléchargement de l'artefact '$1' échoué."; }
log "téléchargement…"
dl nexus-agent "$WORKDIR/nexus-agent"; dl nexus-agent.sha256 "$WORKDIR/nexus-agent.sha256"; dl VERSION "$WORKDIR/VERSION"

# 2. vérifier le sha256
( cd "$WORKDIR" && sha256sum -c nexus-agent.sha256 >/dev/null 2>&1 ) \
  || die "sha256 MISMATCH — l'artefact ne correspond pas au sha de la CI. ABANDON."
ART_SHA="$(sha256sum "$WORKDIR/nexus-agent" | awk '{print $1}')"
VERSION_STR="$(tr -d '\r\n' < "$WORKDIR/VERSION")"; [ -n "$VERSION_STR" ] || die "VERSION vide dans l'artefact."

# 3. APPROBATION ÉCLAIRÉE
size=$(wc -c < "$WORKDIR/nexus-agent" | tr -d ' ')
printf '\n%s──────── APPROBATION DE RELEASE ────────%s\n' "$c_bld" "$c_rst"
printf '  Tag            : %s\n' "$VER"
printf '  Version (CI)   : %s\n' "$VERSION_STR"
printf '  Artefact       : nexus-agent (%s octets)\n' "$size"
printf '  SHA256         : %s%s%s\n' "$c_bld" "$ART_SHA" "$c_rst"
printf '  Publié vers    : %s@%s:/release/\n' "$PROD_RELEASE_USER" "$PROD_HOST"
printf '%s────────────────────────────────────────%s\n' "$c_bld" "$c_rst"
printf 'Vérifie que cette version + ce SHA256 correspondent à la release attendue.\n'
reply=""; read -r -p "Approuver et signer cette release ? (y/N) " reply < /dev/tty || true
case "$reply" in y|Y|yes|YES|oui|OUI) : ;; *) audit REFUSED "non approuvé"; die "release NON approuvée — rien signé ni publié." ;; esac

# 4. signature locale (CORRECTIF A : distinguer OOM 137 du mauvais mot de passe)
log "signature locale (minisign) — saisis le mot de passe de ta clé :"
set +e; minisign -S -s "$RELEASE_KEY" -m "$WORKDIR/nexus-agent"; rc=$?; set -e
case "$rc" in
  0) : ;;
  137) die "minisign TUÉ (signal 9 / OOM). scrypt a besoin de ~1–2 Go RAM — augmente la RAM de la LXC." ;;
  *)   die "signature échouée (code $rc) — mauvais mot de passe ?" ;;
esac
[ -f "$WORKDIR/nexus-agent.minisig" ] || die "signature absente après minisign -S."
# auto-vérif locale si la clé publique est à côté de la privée
if [ -f "${RELEASE_KEY%.key}.pub" ]; then
  if minisign -Vm "$WORKDIR/nexus-agent" -p "${RELEASE_KEY%.key}.pub" >/dev/null 2>&1; then
    log "auto-vérif de la signature : OK."
  else
    die "auto-vérif de la signature a échoué (clés pub/priv incohérentes ?)."
  fi
fi

# 5. publication atomique (rsync --delay-updates ; écrase proprement une republication)
log "publication dans /release sur $PROD_HOST via $PROD_RELEASE_USER (atomique)…"
rsync -a --delay-updates -e "ssh -i $NEXUS_RELEASE_SSH_KEY -o StrictHostKeyChecking=$SSH_STRICT" \
  "$WORKDIR/nexus-agent" "$WORKDIR/nexus-agent.minisig" "$WORKDIR/VERSION" \
  "$PROD_RELEASE_USER@$PROD_HOST:/" \
  || die "rsync vers $PROD_RELEASE_USER@$PROD_HOST a échoué — RIEN publié (bascule atomique non effectuée)."

# 6. journaliser
audit OK "publiée"
log "${c_grn}Release $VER publiée (version $VERSION_STR).${c_rst}"
log "Journal : $LOG_FILE"
