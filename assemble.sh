#!/bin/bash
# Assemble the Next.js standalone bundle for the systemd unit.
# The unit runs: node custom-server.js from .next/standalone, so every file the
# server needs at runtime that `next build` does not copy must be placed here.
#
#  - .next/static and public/: build output, NOT included in the standalone tree
#    by default. Without them every page renders its shell stuck at "Loading..."
#    because the hashed client chunks and the public/ assets answer 404.
#
# Why the source tree is copied wholesale: custom-server.js imports server
# modules by absolute path under its own __dirname (dashboardGuard, the auth
# guard hooks, telegramBackup, backgroundTokenRefresh, securityLogRepo,
# dashboardSession). `next build` only traces the subset of src/ that reached
# the webpack graph, so those files were missing and AuthGuard answered 503
# with "guard unavailable". A superset of src/ is what the unit expects.
set -e
cd /root/9router

# The Next app lives in the apps/web workspace member now, so the build output is
# nested one level deeper and its standalone server lands at apps/web/server.js.
cd apps/web

if [ ! -f .next/standalone/apps/web/server.js ]; then
  echo "assemble: .next/standalone/apps/web/server.js missing - run 'bun run build' first" >&2
  exit 1
fi

# server-side source tree + launch hooks the custom server imports by path
rm -rf .next/standalone/src .next/standalone/scripts
cp -a src        .next/standalone/src
cp -a scripts    .next/standalone/scripts

# client bundle + static assets served by the standalone server
mkdir -p .next/standalone/.next .next/standalone/public
rm -rf .next/standalone/.next/static
cp -a .next/static .next/standalone/.next/static
cp -a public/.     .next/standalone/public/

# files the unit reads from its working directory
cp -a custom-server.js .next/standalone/custom-server.js
cp -a ../../CHANGELOG.md .next/standalone/CHANGELOG.md
cp -a package.json     .next/standalone/package.json

# next ships its own copy of some runtime deps; the standalone bundle resolves
# `next` from its own node_modules, so mirror the built tree over it.
rm -rf .next/standalone/node_modules/next
cp -a node_modules/next .next/standalone/node_modules/next

# sharp is imported by the image text extractor and is not always included in the
# standalone server's traced node_modules. Keep the runtime image stack beside
# the server for deployments that run a plain `.next/standalone` bundle.
for module in sharp @img detect-libc; do
  if [ -e "node_modules/$module" ]; then
    rm -rf ".next/standalone/node_modules/$module"
    cp -a "node_modules/$module" ".next/standalone/node_modules/$module"
  fi
done

# Turbopack can externalize Sharp under a hashed alias such as
# sharp-dd06f04ad66ec9e7. Recreate those aliases from the real sharp package so
# future deploys do not depend on a manual VPS-only shim.
node scripts/ensure-sharp-runtime-alias.mjs

echo "assemble: ok"
