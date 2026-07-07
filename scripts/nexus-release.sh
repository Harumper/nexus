#!/usr/bin/env bash
#
# nexus-release — CREATES the version tag, waits for the build, then APPROVES+signs+publishes.
#
# Privilege: this machine (signing) holds a GitLab *project access token*
# scoped write_api ON THE nexus PROJECT ONLY. write_api = API read + API WRITE
# (tag creation). The release decision stays HUMAN: YOU run the script and confirm
# the number — this is NOT an automaton releasing on its own, and it is NOT the CI
# creating the tag. The minisign private key NEVER leaves this machine (offline
# signing).
#
# ⚠ GitLab-specific tool. This script drives Nexus's GitLab CI pipeline: it reads
# the `release-build` artifact from the GitLab API and rsyncs it to a prod host.
# If you do NOT run that GitLab CI, do not use this script — follow the
# CI-agnostic build → sign → publish steps in RELEASING.md instead.
#
#   Usage:
#     ./nexus-release.sh                 → proposes the next number, CREATES it (tag on
#                                          master), waits for the build, approval, signs, publishes
#     ./nexus-release.sh --ref <sha>     → same but tags <sha> instead of master
#     ./nexus-release.sh approve vX.Y.Z  → tag ALREADY created: approves + signs + publishes
#                                          (re-sign, or tag created outside the script)
#     (./nexus-release.sh vX.Y.Z works like 'approve vX.Y.Z'; 'approve' is optional)
#
# FLOW (one interaction):
#   1. read the tags (write_api) → propose vX.Y.Z (next patch)
#   2. you confirm on /dev/tty (Enter = proposed, or type another vX.Y.Z)
#   3. anti-downgrade checked BEFORE creation; the tag is created via POST /repository/tags
#      (ref = master by default, --ref <sha> otherwise) → release-build triggers on the tag
#   4. wait for the artifact, approval screen (SHA256) on /dev/tty, password,
#      local minisign signing, atomic publication into /release, logging
#
# Safeguards: strict vX.Y.Z format; anti-downgrade (refuse if a tag >= exists, checked
# BEFORE creation); tag already existing → clear message + switch to 'approve'; key
# preflight BEFORE creating the tag (fail-fast); /dev/tty approval; OOM 137 distinguished
# from wrong password; chmod 600 enforced; atomic publication (rsync --delay-updates);
# append-only log. Any error = non-zero exit + FAIL entry in the log, never a partial
# publication.
#
# ROLLBACK NOTE: if the tag is created but the rest fails (build KO, refusal at
# approval), the tag STAYS in GitLab. This is NOT dangerous — no signed binary is
# published into /release, so nothing is served to agents. Just resume with
# "./nexus-release.sh approve vX.Y.Z". No automatic tag deletion (we avoid erasing a
# legitimate tag on a transient error); after creation the script prints the resume
# command and the manual deletion link if you wish.

set -Eeuo pipefail

# =====================================================================
# CONFIG — fill in ONCE. Token: ~/.config/nexus-release.env (NOT committed) or env.
# =====================================================================
# Variable template: scripts/nexus-release.env.example (copy to ~/.config/nexus-release.env).
[ -f "$HOME/.config/nexus-release.env" ] && . "$HOME/.config/nexus-release.env"

GITLAB_URL="${GITLAB_URL:-https://gitlab.example.com}"
PROJECT_ID="${PROJECT_ID:-your-group%2Fnexus}"       # API: url-encoded path (or ID, e.g. 39)
GITLAB_PROJECT_PATH="${GITLAB_PROJECT_PATH:-your-group/nexus}"   # UI link (manual tag deletion)
RELEASE_JOB="${RELEASE_JOB:-release-build}"
# Token: PROJECT ACCESS TOKEN scoped write_api on the nexus PROJECT ONLY (Developer role;
# Maintainer required if 'v*' tags are protected). write_api covers reading AND creating
# tags — it replaces the old read_api; a single token is enough. ⚠ WRITE right (creates tags).
GITLAB_TOKEN="${GITLAB_TOKEN:-}"
DEFAULT_REF="${DEFAULT_REF:-master}"                 # default tagged ref (override: --ref <sha>)

RELEASE_KEY="${RELEASE_KEY:-$HOME/nexus-signing/nexus-release.key}"
NEXUS_RELEASE_SSH_KEY="${NEXUS_RELEASE_SSH_KEY:-$HOME/.ssh/nexus-release}"
PROD_HOST="${PROD_HOST:-nexus.example.com}"
PROD_RELEASE_USER="${PROD_RELEASE_USER:-nexus-release}"
SSH_STRICT="${SSH_STRICT:-accept-new}"               # 'accept-new' (TOFU first contact) or 'yes' (refuse if not pinned)

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
die() { printf '%s[FAILED]%s %s\n' "$c_red" "$c_rst" "$*" >&2; { [ "$AUDITED" = 0 ] && [ -n "$VER" ]; } && audit FAIL "$*"; exit 1; }
trap 'die "unexpected error (line $LINENO, code $?)"' ERR
WORKDIR=""; cleanup() { [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }; trap cleanup EXIT

API="$GITLAB_URL/api/v4/projects/$PROJECT_ID"
auth=(--header "PRIVATE-TOKEN: $GITLAB_TOKEN")
[ -n "$GITLAB_TOKEN" ] || die "GITLAB_TOKEN empty. Set a write_api token (nexus project access token) in the env or ~/.config/nexus-release.env."
command -v curl >/dev/null || die "curl missing."

# Lists clean vX.Y.Z tags (sorted -V), with explicit API errors.
fetch_tags() {
  local resp code body
  resp="$(curl -s -w $'\n%{http_code}' "${auth[@]}" "$API/repository/tags?per_page=100")" || die "tags API call failed."
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  case "$code" in
    200) : ;;
    401|403) die "API denies access (HTTP $code) — valid write_api token?" ;;
    404) die "project not found (HTTP 404) — PROJECT_ID ($PROJECT_ID)?" ;;
    *) die "tags API: HTTP $code." ;;
  esac
  # || true: zero vX.Y.Z tags is a LEGITIMATE state (1st release); without it, the final grep
  # exits with code 1 and, under pipefail, makes the whole function fail (trap ERR).
  printf '%s' "$body" | grep -oE '"name":"[^"]*"' | sed -E 's/^"name":"//; s/"$//' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V || true
}
bump_patch() { local v="${1#v}" M m p; M="${v%%.*}"; v="${v#*.}"; m="${v%%.*}"; p="${v#*.}"; printf 'v%s.%s.%s' "$M" "$m" "$((p+1))"; }

# Creates the tag via the API (write_api). 201 = created; explicit error codes.
create_tag() {
  local tag="$1" ref="$2" resp code body
  resp="$(curl -s -w $'\n%{http_code}' -X POST "${auth[@]}" \
    --data-urlencode "tag_name=$tag" --data-urlencode "ref=$ref" \
    "$API/repository/tags")" || die "tag creation API call failed."
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  case "$code" in
    201) : ;;
    400)
      if printf '%s' "$body" | grep -qi 'already exists'; then
        die "tag $tag already exists (race?) — (re)sign it: $0 approve $tag"
      fi
      die "tag creation refused (HTTP 400) — invalid ref '$ref'? Detail: $body" ;;
    401|403) die "creation refused (HTTP $code) — does the token have the write_api scope AND a sufficient role? (protected 'v*' tags → Maintainer required; otherwise Developer). Detail: $body" ;;
    404) die "project or ref not found (HTTP 404) — does the ref '$ref' exist? PROJECT_ID ($PROJECT_ID)? Detail: $body" ;;
    *) die "tag creation: HTTP $code — $body" ;;
  esac
}

# ---- args: [--ref <sha>] [approve] [vX.Y.Z] ----
REF="$DEFAULT_REF"; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)   REF="${2:-}"; [ -n "$REF" ] || die "--ref requires an argument (sha or branch name)."; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; [ -n "$REF" ] || die "--ref= empty."; shift ;;
    approve) shift ;;                                  # optional keyword
    -*)      die "unknown option: $1" ;;
    *)       ARGS+=("$1"); shift ;;
  esac
done
MODE="create"; [ "${#ARGS[@]}" -ge 1 ] && { MODE="approve"; VER="${ARGS[0]}"; }

# ---- signing/publication preflight (BEFORE any tag creation: fail-fast) ----
[ -f "$RELEASE_KEY" ] || die "minisign private key not found: $RELEASE_KEY (config RELEASE_KEY)."
[ -f "$NEXUS_RELEASE_SSH_KEY" ] || die "nexus-release SSH key not found: $NEXUS_RELEASE_SSH_KEY."
for b in minisign rsync ssh sha256sum awk stat; do command -v "$b" >/dev/null || die "required tool missing: $b."; done
# key permissions (SSH ignores an over-open key → password fallback → failure)
for k in "$RELEASE_KEY" "$NEXUS_RELEASE_SSH_KEY"; do
  perms="$(stat -c '%a' "$k")" || die "cannot read the permissions of $k."
  [ $((8#$perms & 077)) -eq 0 ] || die "key $k too permissive ($perms) — SSH/minisign may ignore it (password fallback → failure). Run: chmod 600 $k"
done

# ============================ CREATE MODE ============================
# Propose a number, confirm it, check anti-downgrade BEFORE creating the tag.
if [ "$MODE" = "create" ]; then
  log "reading the tags (write_api)…"
  tags="$(fetch_tags)"
  last="$(printf '%s\n' "$tags" | grep -E '^v' | tail -1 || true)"
  if [ -z "$last" ]; then proposed="v0.0.1"; last_disp="(no clean version)"; else proposed="$(bump_patch "$last")"; last_disp="$last"; fi
  printf '\n%s──────── NEW RELEASE ────────%s\n' "$c_bld" "$c_rst"
  printf '  Latest version   : %s\n' "$last_disp"
  printf '  Proposed (patch) : %s%s%s\n' "$c_bld" "$proposed" "$c_rst"
  printf '  Tag created on ref: %s%s%s\n' "$c_bld" "$REF" "$c_rst"
  printf '  (minor → bump the middle, e.g. v0.1.0; major → v1.0.0)\n'
  printf '%s──────────────────────────────────%s\n' "$c_bld" "$c_rst"
  reply=""; read -r -p "Version number [${proposed}]: " reply < /dev/tty || true
  VER="${reply:-$proposed}"
  case "$VER" in v[0-9]*.[0-9]*.[0-9]*) : ;; *) die "invalid format '$VER' — expected vX.Y.Z." ;; esac
  # already existing → we do NOT create, we switch to approve
  printf '%s\n' "$tags" | grep -qx "$VER" && die "tag $VER already exists — to (re)sign it: $0 approve $VER"
  # anti-downgrade: VER must be strictly the most recent (checked BEFORE creation)
  if [ -n "$last" ]; then
    max="$(printf '%s\n%s\n' "$tags" "$VER" | sort -V | tail -1)"
    [ "$max" = "$VER" ] || die "anti-downgrade: a more recent tag exists ($max) — creating $VER would publish an older version."
  fi
  log "creating tag $VER (ref=$REF)…"
  create_tag "$VER" "$REF"
  log "tag $VER created → release-build triggered on the tag."
  warn "if the rest fails, tag $VER stays created. Resume: $0 approve $VER"
  warn "optional manual deletion: $GITLAB_URL/$GITLAB_PROJECT_PATH/-/tags (the tag $VER)"
fi

# ============================ APPROVE MODE ============================
# Tag already created (this script or outside it): validate it exists + anti-downgrade.
if [ "$MODE" = "approve" ]; then
  case "$VER" in v[0-9]*.[0-9]*.[0-9]*) : ;; *) die "invalid format '$VER' — expected vX.Y.Z." ;; esac
  tags="$(fetch_tags)"
  printf '%s\n' "$tags" | grep -qx "$VER" || die "tag $VER does not exist — run \"$0\" (no argument) to create it."
  max="$(printf '%s\n' "$tags" | sort -V | tail -1)"
  [ "$max" = "$VER" ] || die "anti-downgrade: a more recent tag exists ($max) — approving $VER would publish an older version."
fi

# ============= COMMON FLOW: artifact → approval → signing → publication =============
# 1. fetch THIS TAG's artifact (chatty poll)
WORKDIR="$(mktemp -d)"
art_url() { printf '%s/jobs/artifacts/%s/raw/%s?job=%s' "$API" "$VER" "$1" "$RELEASE_JOB"; }
log "waiting for the '$RELEASE_JOB' artifact of tag $VER (timeout ${POLL_TIMEOUT}s)…"
deadline=$(( $(date +%s) + POLL_TIMEOUT ))
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$(art_url nexus-agent.sha256)") || code=000
  case "$code" in
    200) log "artifact available." ; break ;;
    401|403) die "API denies access (HTTP $code) — write_api token?" ;;
    404) warn "not ready yet (HTTP 404) — release-build not (yet) succeeded for $VER. $(( deadline - $(date +%s) ))s left." ;;
    *) warn "unexpected response HTTP $code, retrying…" ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || die "timeout: no artifact for $VER (release-build finished/succeeded?)."
  sleep "$POLL_INTERVAL"
done
dl() { curl -fsSL "${auth[@]}" "$(art_url "$1")" -o "$2" || die "download of artifact '$1' failed."; }
log "downloading…"
dl nexus-agent "$WORKDIR/nexus-agent"; dl nexus-agent.sha256 "$WORKDIR/nexus-agent.sha256"; dl VERSION "$WORKDIR/VERSION"

# 2. verify the sha256
( cd "$WORKDIR" && sha256sum -c nexus-agent.sha256 >/dev/null 2>&1 ) \
  || die "sha256 MISMATCH — the artifact does not match the CI sha. ABORT."
ART_SHA="$(sha256sum "$WORKDIR/nexus-agent" | awk '{print $1}')"
VERSION_STR="$(tr -d '\r\n' < "$WORKDIR/VERSION")"; [ -n "$VERSION_STR" ] || die "VERSION empty in the artifact."

# 3. INFORMED APPROVAL
size=$(wc -c < "$WORKDIR/nexus-agent" | tr -d ' ')
printf '\n%s──────── RELEASE APPROVAL ────────%s\n' "$c_bld" "$c_rst"
printf '  Tag            : %s\n' "$VER"
printf '  Version (CI)   : %s\n' "$VERSION_STR"
printf '  Artifact       : nexus-agent (%s bytes)\n' "$size"
printf '  SHA256         : %s%s%s\n' "$c_bld" "$ART_SHA" "$c_rst"
printf '  Published to   : %s@%s:/release/\n' "$PROD_RELEASE_USER" "$PROD_HOST"
printf '%s────────────────────────────────────────%s\n' "$c_bld" "$c_rst"
printf 'Verify that this version + this SHA256 match the expected release.\n'
reply=""; read -r -p "Approve and sign this release? (y/N) " reply < /dev/tty || true
case "$reply" in y|Y|yes|YES|oui|OUI) : ;; *) audit REFUSED "not approved"; die "release NOT approved — nothing signed or published." ;; esac

# 4. local signing (distinguish OOM 137 from wrong password)
log "local signing (minisign) — enter your key password:"
set +e; minisign -S -s "$RELEASE_KEY" -m "$WORKDIR/nexus-agent"; rc=$?; set -e
case "$rc" in
  0) : ;;
  137) die "minisign KILLED (signal 9 / OOM). scrypt needs ~1–2 GB RAM — increase the LXC RAM." ;;
  *)   die "signing failed (code $rc) — wrong password?" ;;
esac
[ -f "$WORKDIR/nexus-agent.minisig" ] || die "signature missing after minisign -S."
# local self-check if the public key sits next to the private one
if [ -f "${RELEASE_KEY%.key}.pub" ]; then
  if minisign -Vm "$WORKDIR/nexus-agent" -p "${RELEASE_KEY%.key}.pub" >/dev/null 2>&1; then
    log "signature self-check: OK."
  else
    die "signature self-check failed (inconsistent pub/priv keys?)."
  fi
fi

# 5. atomic publication (rsync --delay-updates; cleanly overwrites a republication)
log "publishing into /release on $PROD_HOST via $PROD_RELEASE_USER (atomic)…"
rsync -a --delay-updates -e "ssh -i $NEXUS_RELEASE_SSH_KEY -o StrictHostKeyChecking=$SSH_STRICT" \
  "$WORKDIR/nexus-agent" "$WORKDIR/nexus-agent.minisig" "$WORKDIR/VERSION" \
  "$PROD_RELEASE_USER@$PROD_HOST:/" \
  || die "rsync to $PROD_RELEASE_USER@$PROD_HOST failed — NOTHING published (atomic switch not performed)."

# 5b. Keep a LOCAL copy of the signed artifacts (binary + detached signature + VERSION,
# + public key if available) under $LOG_DIR/artifacts/<tag>/. Lets you re-distribute the
# EXACT same signed binary later (audit, manual upload) WITHOUT re-signing — the same
# signed bytes served from /release can be published elsewhere.
ARTIFACT_DIR="$LOG_DIR/artifacts/$VER"
mkdir -p "$ARTIFACT_DIR"
cp -f "$WORKDIR/nexus-agent" "$WORKDIR/nexus-agent.minisig" "$WORKDIR/VERSION" "$ARTIFACT_DIR/"
[ -f "${RELEASE_KEY%.key}.pub" ] && cp -f "${RELEASE_KEY%.key}.pub" "$ARTIFACT_DIR/nexus-release.pub"
log "signed artifacts kept locally: $ARTIFACT_DIR"

# 6. log
audit OK "published"
log "${c_grn}Release $VER published (version $VERSION_STR).${c_rst}"
log "Log: $LOG_FILE"
