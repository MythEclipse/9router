#!/bin/bash
# Deploy 9router to imrnes from the payload CI built.
#
# Runs as root on imrnes, invoked ONLY through /usr/local/bin/gh-actions-9router,
# which is a forced command: the CI key cannot run anything else on this host.
#
# A release is unpacked beside the live one and swapped by symlink, so a failed
# start leaves the previous release serving. node_modules is installed per
# release rather than shared: a shared tree pins one Next version against several
# .next builds, which crashes at boot with "canonicalBase" instead of failing the
# deploy. Secrets and data live outside the release tree and are never touched.
#
# The build happens in CI because imrnes runs other services and has no Rust/Bun
# toolchain worth keeping; a `next build` on the box would compete for the RAM
# that keeps them up.

set -euo pipefail

APP=/opt/9router
RELEASES=$APP/releases
CURRENT=$APP/current
UNIT=9router
SERVICE_USER=9router
DATA_DIR=/var/lib/9router
BUN_DIR=$APP/.bun
UPLOAD=$APP/upload/9router-payload.tar.gz
PORT=2028
PUBLIC_HOST=omniroute.imrnes.team
KEEP=3

say() { printf '%s\n' "$*"; }
fatal() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# ── pre-flight ─────────────────────────────────────────────────────────────
say "── pre-flight ──"
[ -f "$UPLOAD" ] || fatal "no payload at $UPLOAD"
# A truncated upload is the failure this catches: tar would fail halfway through
# unpacking and leave a half-release that still looks like a directory.
tar -tzf "$UPLOAD" >/dev/null || fatal "payload is not a readable tarball"

SHA=$(tar xzOf "$UPLOAD" ./.deploy-sha 2>/dev/null | tr -d '\r\n' || true)
[ -n "$SHA" ] || fatal "payload has no .deploy-sha marker"
RELEASE=$RELEASES/$SHA

say "payload  : $(du -h "$UPLOAD" | cut -f1) sha=$SHA"
say "release  : $RELEASE"

# ── runtime user and dirs ──────────────────────────────────────────────────
# The unit runs as an unprivileged user, so the account has to exist before the
# first start. Idempotent: a redeploy must not touch an existing account.
ensure_service_user() {
  id -u "$SERVICE_USER" >/dev/null 2>&1 && return 0
  useradd --system --create-home --home-dir "$APP" --shell /usr/sbin/nologin "$SERVICE_USER"
  say "created service user $SERVICE_USER"
}

ensure_service_user
mkdir -p "$RELEASES" "$DATA_DIR" "$APP/upload" "$BUN_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$RELEASES" "$DATA_DIR"

# ── bun ────────────────────────────────────────────────────────────────────
# Bun is the installer AND the runtime: apps/api opens SQLite with `bun:sqlite`,
# which Node cannot resolve. The failure is a 500 on every database route while
# /api/health keeps answering 200, so a liveness probe alone would call it good.
# Installed inside the app tree so the service user can execute it without
# reaching into /root, and because the path appears verbatim in the unit.
#
# Progress goes to stderr, not stdout: the caller captures this function's
# stdout as the bun path, and a status line on stdout becomes part of that path
# ("installing bun into ..." was being executed as a command).
resolve_bun() {
  if [ -x "$BUN_DIR/bin/bun" ]; then
    echo "$BUN_DIR/bin/bun"
    return 0
  fi
  say "installing bun into $BUN_DIR" >&2
  HOME=/root BUN_INSTALL="$BUN_DIR" bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null 2>&1 \
    || fatal "bun install failed"
  [ -x "$BUN_DIR/bin/bun" ] || fatal "bun not available after install"
  echo "$BUN_DIR/bin/bun"
}
BUN=$(resolve_bun)
say "bun      : $($BUN --version)"

# ── unpack ─────────────────────────────────────────────────────────────────
say "── unpack ──"
STAGING=$RELEASES/.staging-$$
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$UPLOAD" -C "$STAGING" --exclude=.deploy-sha

# Assert the real entrypoints before the symlink moves: a partial payload would
# otherwise only surface as a failed health check after the cutover.
[ -f "$STAGING/custom-server.js" ] || fatal "payload has no custom-server.js"
[ -f "$STAGING/server.js" ] || fatal "payload has no server.js"
[ -d "$STAGING/.next" ] || fatal "payload has no .next build"
[ -d "$STAGING/migrations" ] || fatal "payload has no migrations/"

# ── dependencies ───────────────────────────────────────────────────────────
say "── dependencies ──"
# --frozen-lockfile refuses a stale lockfile, which is why CI resolves one for
# the payload manifest rather than shipping the repo's.
( cd "$STAGING" && HOME=/root "$BUN" install --frozen-lockfile ) || fatal "bun install failed"
[ -d "$STAGING/node_modules" ] || fatal "bun install produced no node_modules"

# Assert next resolves from the release's own node_modules. A bad resolution
# only surfaces much later, as a canonicalBase crash at boot. Resolved from
# apps/web, which is where the server runs: the root manifest declares only
# workspaces, so require.resolve there answers MODULE_NOT_FOUND.
resolved_next=$( cd "$STAGING/apps/web" && node -e "console.log(require.resolve('next'))" 2>/dev/null || echo "" )
case "$resolved_next" in
  "$STAGING"/*) : ;;
  *) fatal "next resolves outside the release ($resolved_next) — refusing to activate" ;;
esac
say "next     : resolves inside the release"

rm -rf "$RELEASE"
mv "$STAGING" "$RELEASE"
chown -R "$SERVICE_USER:$SERVICE_USER" "$RELEASE"

# ── secrets ────────────────────────────────────────────────────────────────
# .env lives outside the release tree, so it survives every deploy. Generated
# exactly once: regenerating on redeploy would invalidate every stored session
# and every issued API key.
say "── secrets ──"
if [ -f "$APP/.env" ]; then
  say "reusing existing $APP/.env (secrets preserved)"
else
  umask 077
  {
    echo "PORT=$PORT"
    echo "HOSTNAME=127.0.0.1"
    echo "NODE_ENV=production"
    echo "DATA_DIR=$DATA_DIR"
    echo "NEXT_TELEMETRY_DISABLED=1"
    # The dashboard is served over HTTPS at the public hostname, so the session
    # cookie must be marked Secure.
    echo "AUTH_COOKIE_SECURE=true"
    echo "BASE_URL=https://$PUBLIC_HOST"
    echo "NEXT_PUBLIC_BASE_URL=https://$PUBLIC_HOST"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "API_KEY_SECRET=$(openssl rand -hex 32)"
    echo "MACHINE_ID_SALT=$(openssl rand -hex 16)"
    # Human-readable so the operator can log in; the others are never read by a
    # human. Changed from the dashboard Profile page after the first login.
    echo "INITIAL_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
  } > "$APP/.env"
  say "generated $APP/.env with fresh secrets"
  say "  dashboard login password: $(grep '^INITIAL_PASSWORD=' "$APP/.env" | cut -d= -f2)"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$APP/.env"
chmod 600 "$APP/.env"

# ── unit ───────────────────────────────────────────────────────────────────
# Installed from the payload so the running unit always matches the deployed
# commit; a unit left behind from an older layout would keep serving the old
# tree while this script reported success.
say "── unit ──"
UNIT_SRC=$RELEASE/deploy/imrnes/9router.service
[ -f "$UNIT_SRC" ] || fatal "payload has no deploy/imrnes/9router.service"
install -m 0644 "$UNIT_SRC" "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
# Enabled, not just started: a host reboot that leaves the gateway down is the
# same outage as a failed deploy, only later and with nobody watching.
systemctl enable "$UNIT" >/dev/null 2>&1 || true

PREVIOUS=$(readlink -f "$CURRENT" 2>/dev/null || true)
say "previous : ${PREVIOUS:-none}"

# ── activate ───────────────────────────────────────────────────────────────
say "── swap ──"
NEW_LINK=$CURRENT.new.$$
ln -sfn "$RELEASE" "$NEW_LINK"
if [ -L "$CURRENT" ]; then
  mv -Tf "$NEW_LINK" "$CURRENT"   # atomic rename(2)
else
  rm -rf "$CURRENT"
  mv -Tf "$NEW_LINK" "$CURRENT"
fi
[ -e "$CURRENT/custom-server.js" ] || fatal "$CURRENT does not point at a release"

# ── restart ────────────────────────────────────────────────────────────────
say "── restart ──"
# `systemctl restart` alone can race: the old process may not have released the
# port by the time the new one binds, giving EADDRINUSE. Stop, then wait for the
# port to actually close. Probed with bash's /dev/tcp rather than `fuser`,
# because psmisc is not installed on this host and a deploy must not depend on a
# package a fresh image may not carry.
systemctl stop "$UNIT" 2>/dev/null || true
for attempt in $(seq 1 15); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    break
  fi
  if [ "$attempt" = "15" ]; then
    say "warning: port $PORT still bound after 15s, starting anyway"
  fi
  sleep 1
done
systemctl start "$UNIT"

# ── health ─────────────────────────────────────────────────────────────────
# Both probes must pass. /api/health alone is not enough: it answers 200 from a
# process that cannot open its database, which is exactly what a Node launcher
# against bun:sqlite produced — a green deploy with a broken dashboard.
say "── health ──"
healthy=0
for attempt in $(seq 1 40); do
  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 000)
  auth=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/auth/status" 2>/dev/null || echo 000)
  if [ "$health" = "200" ] && [ "$auth" = "200" ]; then
    say "attempt $attempt: /api/health $health, /api/auth/status $auth"
    healthy=1
    break
  fi
  [ "$attempt" = "40" ] && say "attempt $attempt: /api/health $health, /api/auth/status $auth"
  sleep 2
done

if [ "$healthy" != "1" ]; then
  say "FAIL: $UNIT did not serve both probes on 127.0.0.1:$PORT"
  journalctl -u "$UNIT" -n 40 --no-pager | tail -40
  # Leaving the host on a release that does not start is worse than leaving it
  # one commit behind.
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    say "rolling back to $PREVIOUS"
    ln -sfn "$PREVIOUS" "$CURRENT"
    systemctl restart "$UNIT"
    say "rolled back"
  fi
  exit 1
fi

# ── prune ──────────────────────────────────────────────────────────────────
# Runs last: pruning first would destroy the rollback target of the release you
# are rolling back to.
say "── prune ──"
LIVE=$(basename "$(readlink -f "$CURRENT")")
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  name=$(basename "$old")
  [ "$name" = "$LIVE" ] && continue
  say "removing $old"
  rm -rf "$old"
done

rm -f "$UPLOAD"

say "── result ──"
systemctl is-active "$UNIT"
say "deployed $SHA -> $CURRENT"
say "OK"
