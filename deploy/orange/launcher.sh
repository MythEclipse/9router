#!/usr/bin/env bash
# 9Router — Next.js custom server.
#
# Runs under Bun, not Node. apps/api opens its SQLite handle with
# `bun:sqlite`, which Node cannot resolve; the failure surfaces as a 500 on
# every route that touches the store (the dashboard's auth status among them)
# while /api/health keeps answering 200, so a liveness check alone does not
# catch it. deploy-native.sh runs bun on the imrnes host for the same reason.
#
# Installed to /opt/9router/bin/9router by the deploy job, so it is versioned
# with the code it starts rather than edited by hand on the host.
set -euo pipefail

BUN=""
for candidate in /usr/local/bin/bun /root/.bun/bin/bun /home/9router/.bun/bin/bun; do
  if [ -x "$candidate" ]; then
    BUN="$candidate"
    break
  fi
done

if [ -z "$BUN" ]; then
  echo "9router launcher: bun not found (looked in /usr/local/bin, /root/.bun/bin, /home/9router/.bun/bin)" >&2
  exit 1
fi

cd "${APP_DIR:-/opt/9router/current}"
exec "$BUN" custom-server.js
