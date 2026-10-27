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

COPY package.json ./
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

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# The auth guard runs outside the bundle: custom-server.js imports src/ and
# scripts/ by path, and the loader in scripts/auth-guard-hooks.mjs maps the "@/"
# alias back onto ./src. File tracing only follows static imports, so none of it
# reached the image: getGuardModule() resolved nothing, and before fail-closed
# handling every request was served with no authorization at all - a fresh deploy
# opened straight onto the dashboard with no login form.
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
# The guard imports that src/ tree directly, so Node resolves those bare
# specifiers against ./node_modules instead of through webpack. jose (JWT
# sign/verify), uuid and bcryptjs are reached by dashboardSession and the repos
# but were never bundled, so their absence made the guard import throw - which
# fail-closed then turned into a 503 on every page.
COPY --from=builder /app/node_modules/jose ./node_modules/jose
COPY --from=builder /app/node_modules/uuid ./node_modules/uuid
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# Sharp and its native image helpers are required by the runtime OCR/image-text
# extractor. They are not always left in the standalone bundle unless copied
# explicitly, which produces the hashed `sharp-<hash>` external-module crash.
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
COPY --from=builder /app/node_modules/detect-libc ./node_modules/detect-libc
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
