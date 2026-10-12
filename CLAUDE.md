# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite IS all-green on a plain checkout** — 3928 passing, 0 failing assertions, 0 non-passing files. Gate it after every change:
> ```bash
> cd tests && npx vitest run --reporter=json --outputFile=/tmp/r.json && node __baseline__/verify-no-regression.mjs /tmp/r.json
> ```
> expect `No regression`, then run the `node:test` suites too (vitest cannot see them — see below):
> ```bash
> for f in unit/kimchi.test.js unit/kimchi-strip-reasoning.test.js unit/cline-auth.test.js; do node --test --test-reporter=tap "$f"; done
> ```
> `known-fails.txt` is currently **empty** and the gate expects that (`now fails=0, baseline known=0`). Do not re-add entries for failures you did not fix, and if a fix lands **delete the entry** in the same commit; a stale entry is how a suite rots, by asserting values a later deliberate change moved.
>
> **Three files are `node:test`, not vitest** (`kimchi`, `kimchi-strip-reasoning`, `cline-auth`). Vitest collects them by glob, runs none of their assertions, and fails each file with "No test suite found" — so they are excluded in `vitest.config.js` and executed by the "Run node:test suites" step in `deploy.yml`. Do not "fix" one by converting it back into the vitest include glob; that silently removes it from CI. A new `node:test` file needs the same two edits.
>
> `real/*.real.test.js` make live provider calls — need credentials, skip otherwise. `unit/mimo-free.live.test.js` hits MiMo's real endpoints and goes red if that upstream changes its contract again; assert the behaviour you actually care about (see the anti-abuse gate test), not a bare status code.
>
> Note the gate counts **collection failures too**, not just failed assertions. A file that dies on `import("lowdb")` or "No test suite found" has an empty `assertionResults`, so assertion-only counting reports 0 failures while whole files are broken — that blind spot hid six broken files here.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### Web search for the Anthropic protocol (`open-sse/handlers/webSearch*.js`)
Claude Code declares Anthropic's `web_search_20250910` server tool. 9router picks a lane per request: **passthrough** when the upstream runs the search itself (Anthropic-family providers — `tools` untouched), **bridge** otherwise, where 9router runs the search through its own `/v1/search` path and splices a `server_tool_use` + `web_search_tool_result` block pair into the response.
- **Bridged searches must go through the app's `/v1/search` handler** (`searchEndpointRunner` in `src/sse/handlers/chat.js`), not straight to `handleSearchCore`. Combo expansion, per-key access and combo fallback live only there, and a combo name is not in `AI_PROVIDERS` so provider-id resolution can never select one.
- Prefer a connected candidate over the request's own provider when picking a search engine: `searchViaChat` models often lack search access and the chat account may not be connected.
- Bridge search bodies reuse the existing `/v1/search` contract (`query`, `max_results`, `search_type`, `allowed_domains` → `domain_filter`) — do not invent a new shape.
- The bridge tool declaration is emitted in **the body's own format** (`{type,name,input_schema}` vs `{type:"function",function}`): `installBridgeTool` runs on `translatedBody`, which is already provider-format.
- Tool-use ids must be normalised with `normalizeToolUseId` to Anthropic's `srvtoolu_*` shape on **both** the streaming and non-streaming paths; a raw model id is rejected upstream.
- `frameCanCarrySearch` must accept `input_json_delta` frames — Anthropic streams tool arguments out-of-band from the block start, and gating those frames away loses the query.
- Credentials come from an **injected** resolver (`searchCredentialResolver` in `src/sse/handlers/chat.js`); `open-sse/` must not import the app layer. The lock key travels in the resolver's `options`, not positionally — `getProviderCredentials`'s 3rd positional arg is `model`.
- Streaming injection runs **after** the safeguards wrap, so a searched turn still gets its safeguard verdict.
- **Two tool shapes must both be recognised.** Anthropic's server tool (`type: "web_search_2025xxxx"`, name `web_search`) *and* Claude Code's own client tool `WebSearch` (no `type`). CC never declares the server tool, so matching only the first leaves its searches silently empty. The client-tool shape always takes the bridge lane — passthrough would return nothing.
- `CC_DECOY_TOOLS` must NOT list `WebSearch`: the "currently unavailable" description makes the model emit a stub answer instead of surfacing a real failure.
- `installBridgeTool` must leave CC's declaration alone (its schema carries the domain filters).
- Settings: `webSearchEnabled` (unset = auto-activate when the tool is declared, `false` = force off) and `webSearchProvider` (pin the engine).

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- **Security-first on PRs**: Security is the top priority when reviewing or creating PRs. Audit authentication, credential/token storage & leaks, header manipulation (`X-Forwarded-For`), and SSRF risks before functional logic. Always include explicit security warnings/notes when reporting PR reviews or changes to the user.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
