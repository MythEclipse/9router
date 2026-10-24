#!/usr/bin/env bash
#
# Native systemd deploy for 9router on imrnes (migrated off Docker 2026-10-16).
#
# .github/workflows/ci.yml builds the Next.js release in Actions, tars it and
# streams it to this script over ssh:
#
#     bash /tmp/9router-deploy.sh 9router-release.tgz
#
# The script is scp'd out of the checkout of the commit being deployed, so the
# deploy logic always matches the commit that is being released.
#
# Flow:
#   1. unpack the tarball into /opt/9router/releases/<sha>
#   2. (re)install shared deps into /opt/9router/deps when the manifests changed
#   3. symlink deps/node_modules into the release — imrnes has no pnpm, and a
#      279M node_modules per release would double on every rollback target
#   4. atomically flip /opt/9router/current -> releases/<sha>
#   5. restart the systemd unit, health-check /api/health
#   6. on failure: flip back to the previous release, restart, re-check
#   7. prune old releases (keeps KEEP_RELEASES newest, never the active one)
#
# Secrets and runtime state are NEVER touched: .env lives at /opt/9router/.env
# and DATA_DIR=/var/lib/9router holds the SQLite db, auth dir and catalog.
#
# Overrides: RELEASES_DIR CURRENT_LINK DEPS_DIR UNIT HEALTH_URL PORT KEEP_RELEASES
set -Eeuo pipefail

RELEASES_DIR="${RELEASES_DIR:-/opt/9router/releases}"
CURRENT_LINK="${CURRENT_LINK:-/opt/9router/current}"
PREV_DIR="${CURRENT_LINK}.previous"
DEPS_DIR="${DEPS_DIR:-/opt/9router/deps}"
APP_DIR="${APP_DIR:-/opt/9router}"
UNIT="${UNIT:-9router}"
PORT="${PORT:-2028}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
# Total on disk, live included: 2 = the live release + one rollback target.
KEEP_RELEASES="${KEEP_RELEASES:-2}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

PAYLOAD="${1:-}"
[ -n "$PAYLOAD" ] || die "usage: $0 <release-tgz>"
[ -f "$PAYLOAD" ] || die "payload $PAYLOAD not found"

command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
log "node $(node -v) | user $(id -un)"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif sudo -n true 2>/dev/null; then
    sudo -n "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

# pnpm is the installer for this lockfile (pnpm-lock.yaml). Node.js ships with
# corepack, which provides pnpm. Auto-provision if the host does not have it yet.
resolve_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    command -v pnpm
    return 0
  fi
  log "enabling pnpm via corepack"
  as_root corepack enable pnpm || die "corepack enable pnpm failed"
  command -v pnpm || die "pnpm not available after corepack enable"
}
PNPM="$(resolve_pnpm)"

# ── state captured before we touch anything ────────────────────────────────
PREV_TARGET=""
if [ -L "$CURRENT_LINK" ]; then
  PREV_TARGET="$(readlink "$CURRENT_LINK")"
elif [ -d "$CURRENT_LINK" ]; then
  # First deploy after the Docker era: /opt/9router/current is a real
  # directory. Keep it aside so a rollback can still reach it.
  PREV_TARGET="$PREV_DIR"
fi
ACTIVATED=0

rollback() {
  set +e
  trap - ERR
  log "ROLLING BACK"
  if [ -n "$PREV_TARGET" ] && [ -e "$PREV_TARGET" ]; then
    log "restoring $CURRENT_LINK -> $PREV_TARGET"
    tmp="${CURRENT_LINK}.rollback.$$"
    as_root ln -sfn "$PREV_TARGET" "$tmp" && as_root mv -Tf "$tmp" "$CURRENT_LINK"
  else
    log "no previous release to restore (nothing to roll back to)"
  fi
  as_root systemctl restart "$UNIT"
  health_check || log "WARNING: service still unhealthy after rollback"
}

on_error() {
  local rc="$1" line="$2"
  log "step failed at line $line (exit $rc)"
  if [ "$ACTIVATED" = "1" ]; then
    rollback
  fi
  exit "$rc"
}
# Capture $? inside the trap string: passing only $LINENO would hand the line
# number to $1 and leave $2 unbound, aborting the handler under `set -u` —
# after which the script keeps running past the failure.
trap 'rc=$?; on_error "$rc" "$LINENO"' ERR

health_check() {
  log "health-check $HEALTH_URL"
  # --max-time caps EACH attempt, not the whole sequence.
  timeout 60 curl --fail --silent --show-error \
    --retry 15 --retry-delay 2 \
    --retry-connrefused --retry-all-errors \
    --max-time 10 \
    -o /dev/null "$HEALTH_URL"
}

# ── 1. unpack the release ──────────────────────────────────────────────────
# The SHA comes from the packed manifest written by CI, not from the tarball
# name, so a re-uploaded payload always lands in a fresh directory.
SHA="$(tar xzOf "$PAYLOAD" ./.deploy-sha 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$SHA" ] || die "payload has no .deploy-sha marker"
RELEASE_DIR="${RELEASES_DIR}/${SHA}"
if [ -d "$RELEASE_DIR" ]; then
  log "release dir $RELEASE_DIR already exists — recreating from payload"
  as_root rm -rf "$RELEASE_DIR"
fi
as_root mkdir -p "$RELEASE_DIR"
log "unpacking payload into $RELEASE_DIR"
as_root tar xzf "$PAYLOAD" -C "$RELEASE_DIR" --exclude=.deploy-sha

# Assert the real entrypoint: a partial payload would otherwise only surface as
# a failed health check AFTER the symlink is already flipped.
[ -f "${RELEASE_DIR}/custom-server.js" ] || die "payload has no custom-server.js"
[ -f "${RELEASE_DIR}/server.js" ] || die "payload has no server.js (Next standalone)"
[ -d "${RELEASE_DIR}/.next" ] || die "payload has no .next build"

# ── 2. shared dependency install ───────────────────────────────────────────
# Only reuse the shared install when it was produced BY THIS SCRIPT from this
# exact lockfile. Comparing manifests alone is not enough: node_modules can be
# inherited from an earlier layout (e.g. moved aside from a Docker-era tree),
# and a .next built against one Next.js version dies at runtime under another
# with an obscure ENOENT on a build artefact. The stamp is written only after a
# successful install, so a host that has never run this script always reinstalls.
NEED_INSTALL=0
STAMP="${DEPS_DIR}/.install-stamp"
LOCK_HASH=""
if [ -f "${RELEASE_DIR}/pnpm-lock.yaml" ] && command -v sha256sum >/dev/null 2>&1; then
  LOCK_HASH="$(sha256sum "${RELEASE_DIR}/pnpm-lock.yaml" | cut -d' ' -f1)"
fi

if [ ! -d "${DEPS_DIR}/node_modules" ]; then
  NEED_INSTALL=1
elif [ ! -f "$STAMP" ]; then
  log "no install stamp in $DEPS_DIR — assuming an inherited tree"
  NEED_INSTALL=1
elif [ -n "$LOCK_HASH" ] && [ "$(cat "$STAMP")" != "$LOCK_HASH" ]; then
  NEED_INSTALL=1
fi

if [ "$NEED_INSTALL" = "1" ]; then
  log "installing dependencies into $DEPS_DIR"
  as_root mkdir -p "$DEPS_DIR"
  as_root cp "${RELEASE_DIR}/package.json" "${RELEASE_DIR}/pnpm-lock.yaml" "$DEPS_DIR/"
  # Runs as root with an explicit HOME: sudo's secure_path must not be trusted
  # to find pnpm, and pnpm refuses to write its cache to an unwritable HOME.
  # A subshell with `cd` rather than a --cwd flag: `pnpm --cwd <dir> install`
  # is parsed as a SCRIPT named "install", which fails with "Script not found".
  as_root rm -rf "${DEPS_DIR}/node_modules"
  (
    cd "$DEPS_DIR"
    as_root env HOME=/root PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 "$PNPM" install --frozen-lockfile
  )
  [ -d "${DEPS_DIR}/node_modules" ] || die "pnpm install produced no node_modules"

  # Record what was actually installed, so the next run can tell a matching
  # reuse from a drifted one without trusting a bare directory test.
  next_version="$(node -p "require('${DEPS_DIR}/node_modules/next/package.json').version" 2>/dev/null || echo unknown)"
  log "installed next@${next_version} into $DEPS_DIR"
  if [ -n "$LOCK_HASH" ]; then
    printf '%s' "$LOCK_HASH" | as_root tee "$STAMP" >/dev/null
  else
    printf 'no-lockfile' | as_root tee "$STAMP" >/dev/null
  fi
else
  log "lockfile unchanged since last install -> reusing $DEPS_DIR/node_modules"
fi

# node_modules is root-owned and must resolve relative to the release dir
# (Next resolves deps from __dirname), so every release links to the one copy.
as_root ln -sfn "${DEPS_DIR}/node_modules" "${RELEASE_DIR}/node_modules"

# ── 3. install the unit ────────────────────────────────────────────────────
# Installed from the payload so the running unit always matches the deployed
# commit — a unit left behind from an older layout would keep serving the old
# tree while this script reports success.
UNIT_SRC="${RELEASE_DIR}/deploy/imrnes/9router.service"
[ -f "$UNIT_SRC" ] || die "payload has no deploy/imrnes/9router.service"
as_root cp "$UNIT_SRC" /etc/systemd/system/9router.service
as_root chown root:root /etc/systemd/system/9router.service
as_root chmod 644 /etc/systemd/system/9router.service
as_root systemctl daemon-reload

# ── 4. activate ────────────────────────────────────────────────────────────
log "activating $RELEASE_DIR"
NEW_LINK="${CURRENT_LINK}.new.$$"
as_root ln -sfn "$RELEASE_DIR" "$NEW_LINK"
if [ -L "$CURRENT_LINK" ]; then
  as_root mv -Tf "$NEW_LINK" "$CURRENT_LINK"   # atomic rename(2)
elif [ -e "$CURRENT_LINK" ]; then
  as_root mv "$CURRENT_LINK" "$PREV_DIR"       # directory -> symlink, first run
  if ! as_root mv -Tf "$NEW_LINK" "$CURRENT_LINK"; then
    as_root mv "$PREV_DIR" "$CURRENT_LINK"
    die "could not activate $RELEASE_DIR"
  fi
else
  as_root mv -Tf "$NEW_LINK" "$CURRENT_LINK"
fi
[ -e "${CURRENT_LINK}/custom-server.js" ] || die "$CURRENT_LINK does not point at a release"
ACTIVATED=1

# ── 5. restart + health check ──────────────────────────────────────────────
log "restarting $UNIT"
as_root systemctl restart "$UNIT"
if health_check; then
  ACTIVATED=0
  log "healthy — deploy of ${SHA:0:7} complete"
else
  # `die` below would skip the ERR trap (plain exit), so roll back explicitly.
  rollback
  die "health check failed after deploying ${SHA:0:7}"
fi

# ── 6. prune old releases ──────────────────────────────────────────────────
# Runs LAST: pruning first would destroy the rollback target of the release you
# are rolling back TO.
log "pruning old releases (keeping live + 1 rollback)"
LIVE_SHA="$(basename "$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")")"
[ -n "$LIVE_SHA" ] || die "could not resolve the live release from $CURRENT_LINK"

mapfile -t KEEP < <(
  ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null \
    | while read -r d; do printf '%s\t%s\n' "$(stat -c %Y "$d")" "$(basename "$d")"; done \
    | sort -rn \
    | cut -f2 \
    | while read -r name; do
        [ "$name" = "$LIVE_SHA" ] && continue
        printf '%s\n' "$name"
      done \
    | head -n "$((KEEP_RELEASES - 1))"
)
log "  keeping: live=$LIVE_SHA + ${KEEP[*]:-<none>}"

for dir in "$RELEASES_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [ "$name" = "$LIVE_SHA" ] && continue
  if printf '%s\n' "${KEEP[@]:-}" | grep -qx "$name"; then
    continue
  fi
  log "  pruning $name ($(du -sh "$dir" 2>/dev/null | cut -f1))"
  as_root rm -rf "$dir"
done
log "  releases now: $(ls -1 "$RELEASES_DIR" 2>/dev/null | wc -l)"

log "done: $CURRENT_LINK -> $LIVE_SHA"