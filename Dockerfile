ARG NODE_IMAGE=oven/bun:1.3.14-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

# Use the official Alpine mirror by default. A repository variable/build arg can
# override it for environments that require a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY

RUN apk add --no-cache python3 make g++ linux-headers

# Every workspace manifest must land BEFORE install, or bun sees a lockfile that
# does not match the manifest set and --frozen-lockfile aborts. The workspaces
# are apps/*, packages/* and cli, so all six member manifests belong here —
# shipping only apps/web and cli left apps/api and packages/* unresolvable and
# every build died at the install step below.
COPY package.json bunfig.toml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/pricing/package.json ./packages/pricing/package.json
COPY cli/package.json ./cli/package.json
# The cli workspace's postinstall warms its own runtime by shelling out to
# `npm install` and downloading tray binaries. This image never runs the CLI,
# and the hook sources it imports are not in the build context, so the install
# dies on "Module not found '/app/cli/hooks/postinstall-runner.mjs'". Strip the
# script rather than shipping the hooks: a network warm-up has no business in an
# image build, and it would make the build depend on a registry and a GitHub
# release asset.
RUN bun -e "import fs from 'node:fs'; const p = JSON.parse(fs.readFileSync('cli/package.json', 'utf8')); delete p.scripts.postinstall; fs.writeFileSync('cli/package.json', JSON.stringify(p, null, 2) + '\n')"
# Install opencode-ai CLI globally so the runner image has the opencode binary.
# The bun image ships no npm, so this rides on bun's global installer; the
# package layout it produces differs from npm's, hence the fallback probe below
# searches bun's global root too.
RUN bun install -g opencode-ai --registry="${NPM_REGISTRY}" || true
# Ensure opencode binary is executable and linked in /usr/local/bin. bun links
# global bins straight into its own bin dir, so probe every plausible root.
RUN if [ ! -f /usr/local/bin/opencode ]; then \
      for d in /usr/local/lib/node_modules "$HOME/.bun/install/global/node_modules" /root/.bun/install/global/node_modules; do \
        find "$d"/opencode* -name "opencode" -type f -exec cp {} /usr/local/bin/opencode \; 2>/dev/null || true; \
      done; \
    fi && touch /usr/local/bin/opencode && chmod +x /usr/local/bin/opencode
# No cache mount here on purpose. Railway's builder requires the id to be
# prefixed with a key it generates per service, and the documented form is
# rejected as well, so the mount only breaks the build there. The layer above
# already caches the install, because package.json is copied on its own.
COPY bun.lock ./
# bun resolves bun.lock; the retry knobs above were npm-specific, and bun
# already retries registry failures on its own.
RUN bun install --frozen-lockfile

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

# The Next app now builds under apps/web, so every runtime artifact is copied
# FROM there and flattened into /app — the layout custom-server.js expects.
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/.next/standalone/apps/web ./
COPY --from=builder /app/apps/web/custom-server.js ./custom-server.js
COPY --from=builder /app/apps/web/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/apps/web/src/mitm ./src/mitm
# The auth guard runs outside the bundle: custom-server.js imports src/ and
# scripts/ by path, and the loader in scripts/auth-guard-hooks.mjs maps the "@/"
# alias back onto ./src. File tracing only follows static imports, so none of it
# reached the image: getGuardModule() resolved nothing, and before fail-closed
# handling every request was served with no authorization at all - a fresh deploy
# opened straight onto the dashboard with no login form.
COPY --from=builder /app/apps/web/scripts ./scripts
COPY --from=builder /app/apps/web/src ./src
# bun resolves "@/..." and "open-sse/*" through tsconfig paths, NOT through the
# loader hooks in scripts/auth-guard-hooks.mjs: bun ignores module.register()
# entirely (verified on 1.3.14 and 1.4.2 — the hook's own resolve() works when
# called by hand, and is never invoked by the loader). Production on the VPS has
# this file and serves; an image without it makes the guard import throw, and
# fail-closed then answers 503 to every single request.
COPY --from=builder /app/apps/web/tsconfig.json ./tsconfig.json
# The guard imports the workspace packages by name. bun resolves those through
# node_modules/@9router/* and node_modules/9router-api, which are symlinks to
# ../../packages/* and ../../apps/api — so the link targets have to exist here
# too, or @9router/auth/dashboardSession dies and every page 503s.
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
# The migrator reads the SQL journal from ./migrations beside custom-server.js
# (custom-server.js points MIGRATIONS_DIR at it when present). Without it the
# database never initialises and /api/auth/status answers 500 while /api/health
# still returns 200 — a broken image that looks healthy to a shallow probe.
COPY --from=builder /app/apps/api/migrations ./migrations
# Ship the resolved dependency tree whole. Every previous attempt to name the
# packages the guard needs by hand lost a different one: @swc/helpers (next's
# own closure) and @9router/auth (the session repo) were both absent, and each
# gap is a 503 at runtime that the build cannot see. The tree also carries the
# .bun store that the standalone symlinks point into, so copying it keeps those
# links resolvable instead of dangling.
COPY --from=builder /app/node_modules ./node_modules
# Recreate any Turbopack-hashed Sharp aliases from the real package so future
# deploys survive a poisoned or mismatched dependency tree.
RUN node /app/scripts/ensure-sharp-runtime-alias.mjs || true
# Copy opencode binary from builder stage
COPY --from=builder /usr/local/bin/opencode /usr/local/bin/opencode

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  mkdir -p /home/node && chown -R node:node /home/node && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Avoid a full distribution upgrade in the runtime image. It makes builds less
# reproducible and is unrelated to installing the runtime entrypoint helper.
RUN apk add --no-cache su-exec curl ca-certificates gcompat libstdc++ && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "custom-server.js"]
