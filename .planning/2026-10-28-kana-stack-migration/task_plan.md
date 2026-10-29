# Task Plan: 9Router → Kana TypeScript Stack

## Goal

Migrate the 9Router monolith (Next.js dashboard + OpenAI-compatible SSE gateway,
737 TypeScript files / ~212k LOC) onto the Kana TypeScript stack — bun workspace,
Biome, moon, Hono + oRPC + Drizzle + better-auth API in `apps/api`, TanStack
Router/Query web in `apps/web`, hexagonal four-layer backend — keeping the
gateway serving traffic at every phase boundary.

## Constraints (from user + stack skill)

| Constraint                                                             | Source                   |
| ---------------------------------------------------------------------- | ------------------------ |
| **bun only** — no pnpm, no npm workspace migration                     | user, explicit           |
| **Single-tenant** — one install, one owner, one dashboard auth         | user, explicit           |
| Framework-free `domain/`, deps-injected use-cases, Zod at boundaries   | kana-typescript-stack    |
| Migrations source-controlled; bundle the migrator + its `.sql` journal | kana-typescript-stack #9 |
| Never edit generated files (`routeTree.gen.ts`)                        | kana-typescript-stack #8 |
| Every phase must leave `bun run build` + gateway working               | user, explicit           |
| Clean-code rules apply to every line touched                           | kana-clean-code          |

## Next Step

Phase 8 is authorised: **port every dashboard route handler to oRPC in `apps/api`**,
once, accepting a red build until it completes (user decision, 2026-10-28).

Scope measured before writing any code:

| Set                                      | Count | Notes                                                     |
| ---------------------------------------- | ----- | --------------------------------------------------------- |
| Next route handlers in total             | 199   |                                                           |
| **Port targets**                         | 162   | 18 919 LOC                                                |
| Excluded: `v1/`, `v1beta/`               | 25    | public OpenAI/Gemini contract, must stay REST             |
| Excluded: streaming / binary bodies      | 12    | oRPC JSON serialisation destroys both                     |

Dependency closure of those 162 routes: **304 files, 51 640 LOC**, including
`open-sse/` (43 files). Porting is therefore a backend relocation, not a
transport swap. Progress ledger lives in `progress.md`; per-resource status in
the table below. The `packages/db` strict-typing prerequisite is closed: all
three packages report 0 `tsc` errors and `biome check` is clean.

| Resource       | Routes | Status |
| -------------- | ------ | ------ |
| `system`       | 2      | done — `health`, `changelog` |
| `settings`     | 1      | done — login gate as a use-case with a port |
| `combos`       | 4      | done — create/list/update/delete/duplicate/presets |
| `error-logs`   | 1      | done — page-size rule; failed clear no longer reports success |
| `theme`        | 1      | done — role check as a domain rule (401 vs 403 kept distinct) |
| `locale`       | 1      | done — matches Accept-Language tags, catalogue passed in |
| `keys`         | 3      | done — sub-key caps, ownership, bulk whitelist + 500 cap |
| `pricing`      | 1      | done — stray `?model=` no longer wipes the table |
| `usage`        | 11     | done — one period rule replaces five disagreeing copies |
| `plugins`      | 1      | done — array body no longer wipes every plugin |
| `cache-stats`  | 1      | done — engine module installed by the owning host |
| `dashboard-jobs` | 1    | done — unknown kind refused before a job starts |
| `shutdown`     | 2      | done — one sequence, two gates; 403 vs 401 kept distinct |
| `pxpipe`       | 8      | done — one list-limit rule; engine codes no longer flattened |
| `model-registry` | 12 | done — list/alias/availability/custom/studio/nodes/catalogue; transport whitelist now actually applied |
| `proxy-pools`  | 9      | **done** — `route`, `[id]`, `bulk`, `[id]/test`, four `*-deploy`, `import-jobs` |
| `providers`    | 12 | **done** — connection CRUD, overrides, kilo/free-models, test-models, test-batch, client, `[id]/test`, suggested-models, `validate`, `web-login`, `[id]/models` |
| `tunnel`       | 7      | **done** — `status`, `enable`/`disable`, `tailscale-{check,enable,disable,install}` |
| `cli-tools`    | 15     | **done** — every `*-settings` route on `getUseCases().cliTools`; four own domain modules (`omp` YAML, `jcode` TOML, `hermes` YAML, `grok-build` TOML) |
| (107 more)     | 107    | pending |

Done: 51 of 168 route handlers. `tags` is deliberately **not** ported: it
returns one hardcoded catalogue with no rules, so moving it would add layers
that extract nothing (see findings.md).

`cli-tools` closed with all 15 per-tool settings routes. Eight routes under
`api/cli-tools/` are deliberately still Next-side: `all-statuses` is an aggregate
fan-out, `antigravity-mitm`, `codex-profiles`, `hermes-profiles` and the three
`cowork-*` handlers are profile/process management rather than config editing, so
each needs its own port read before moving. `cowork-settings` is the next settings
route and the last one of that family.

Next: `cowork-settings`, then the remaining `cowork-*` siblings.

Still parked inside `usage/`: `available-models` (360 LOC) and `api-keys`
(351 LOC). They were split off on purpose — they need the engine behind ports,
which is Phase 7's unfinished item, so doing them first would mean porting
`open-sse` twice.

### Prerequisite delivered: shared packages

`packages/db` (SQLite layer), `packages/auth` (session/permissions/OIDC/SAML)
and `packages/pricing` now hold what both apps need. `apps/web` and `apps/api`
consume them through workspace deps, so a ported handler and its unported twin
read the same data through the same code. See `progress.md` for the traps.

## Current Phase

Phase 8 — porting route handlers to oRPC (in progress)

## Phases

### Phase 1: Requirements & Discovery

- [x] Clarify scope with user (full migration, bun, single-tenant)
- [x] Ask the mandatory tenancy question from the stack skill
- [x] Record the existing tsc baseline (0 errors) as the safety net
- [x] Inventory entry points: Next routes, `open-sse` engine, `cli/`, `custom-server`
- [x] Inventory runtime surfaces that must survive: `/v1/*`, dashboard, i18n, SQLite
- [x] Write discovery results to `findings.md`
- **Status:** complete

### Phase 2: Explicit import extensions (extensionless → `.ts`/`.tsx`)

- [x] Byte-preserving Babel rewriter over TS's own resolver (`.codebuddy-tools/`)
- [x] 2 033 specifiers across 540 files rewritten, tsc still 0 errors
- [x] Bare `@/` and `open-sse/*` aliases left intact (npm-package-shaped, resolve from the app dir)
- **Status:** complete

### Phase 3: tsconfig hygiene (unblock TS 7)

- [x] Drop deprecated `baseUrl` (paths are root-relative since TS 5)
- [x] Fix `jsconfig.json` the same way
- **Status:** complete

### Phase 4: bun workspace skeleton (`apps/*`, `packages/*`)

- [x] Root `package.json` → private workspace root with `apps/*`, `packages/*`, `cli`
- [x] Move Next app + `open-sse` engine to `apps/web`
- [x] `bun.lock` regenerated from the workspace root; `pnpm-workspace.yaml` deleted
- [x] CI / Dockerfile / `assemble.sh` updated to `apps/web` paths; YAML validated
- [x] Standalone server boots from the nested build, all 5 migrations apply
- **Status:** complete

### Phase 5: Biome replaces ESLint + Prettier

- [x] `biome.json` — tabs, double quotes, semicolons as needed, `!payload`, `!**/dist`
- [x] Delete `eslint.config.mjs`, `eslint.tmp.mjs`, `.prettierrc.json`, `.prettierignore`
- [x] `lefthook.yml` → biome autofix + regression baseline gate
- [x] 4 030 errors → 424 (all baselined a11y debt), tsc still 0
- **Status:** complete

### Phase 6: moon task graph

- [x] `.moon/workspace.yml`, `tasks.yml`, `toolchain.yml`; `moon.yml` per project
- [x] bun 1.3.14 pinned in `toolchain.yml` — no pnpm anywhere
- [x] Cold proof: `moon clean --all` + rm `.next` → 2 tasks → `.next` (486M)
- **Status:** complete

### Phase 7: `apps/api` — Hono + oRPC + Drizzle + better-auth

- [x] Hono server with Zod-validated env at startup
- [x] oRPC routers: `.input()` → `.use()` → `.handler()`; auth middleware attached
      before the schema so an anonymous caller gets 401, never a 400 that leaks
      the shape of a schema it has no right to probe
- [x] Drizzle schema + migration journal + bundled migrator with `.sql` beside it
      — `scripts/build.ts` copies it and asserts non-empty; the runner finds it by
      walking up from `import.meta.url` and refuses to start when absent
- [x] Four layers wired through `buildUseCases(deps)`; 10 tests over real HTTP
- [ ] better-auth single-tenant session replacing the JWT cookie guard
- [ ] Port `open-sse` behind the four layers (domain ports, application use-cases)
- **Status:** partial — one vertical slice end-to-end; better-auth and open-sse
  remain on the Next side

### Phase 8: `apps/web` — TanStack Router/Query/Form/Table

- [ ] Vite + TanStack Router file routes replacing the App Router
- [ ] shadcn/ui; **no React hooks** (see `references/no-react-hooks.md`)
- [ ] oRPC client; web imports types only from `apps/api`
- **Status:** pending

### Phase 9: Verification & Delivery

- [ ] Parity check against the vitest baseline (`tests/__baseline__/known-fails.txt`)
- [ ] `bun run build` from a cold tree; gateway smoke test on `/v1/chat/completions`
- [ ] Document the rollback boundary per phase
- **Status:** pending

## Decisions Made

| Decision                                        | Rationale                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| bun workspaces, not pnpm                        | user: this project must stay on bun                                         |
| Single-tenant scaffold                          | user: one install, one owner, single dashboard auth                         |
| Phase 2 before Phase 4                          | explicit extensions make the app dir relocatable without a resolver rewrite |
| Babel generator source from Next's bundled copy | adds no dependency; repo is offline and must stay bun-lock stable           |
| `strict` stays `false` for now                  | flipping it opens 13 281 errors; that is its own phase, not a config line   |
| a11y debt baselined, not autofixed              | each of the ~425 needs real markup (htmlFor target, keyboard handler) — an autofix would change behaviour silently |
| `turbopack.root` == `outputFileTracingRoot`     | Next prefers the tracer value and they must match; only the workspace root resolves the hoisted `next` symlink |
| Standalone entry found by search, not layout    | the layout has been `server.js`, `app/`, `<pkg>/`, `apps/web/`; each move added one more guess and one more break |
| `cli:build` depends on `web:build`              | it packages the Next app; a cache hit on unchanged `cli/` inputs silently shipped a stale app |
| Migrator throws on a missing journal            | an empty schema that reports success is worse than a refused start |

## Errors Encountered

| Error                                                                                         | Attempt | Resolution                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Directory-index specifiers got double-suffixed (`/index.ts` → `/index.ts.ts`… 3 broken paths) | 1       | Resolver now returns `/index.ts` when the target file is an index and the specifier is not already one; reverted the tree and re-ran clean |
| `npx tsc` silently reported 0 errors including in `open-sse`                                  | 1       | `open-sse/**` was never in `include`; now included, baseline still 0                                                                       |
| Lifecycle guard refused `./node_modules/.bin/tsc` (bundled `_tsc.js` > 1 MiB scan cap)        | 1       | Invoke `node node_modules/typescript/bin/tsc` instead                                                                                      |
| Turbopack: "Could not find the Next.js package" after the move                                | 1       | `turbopack.root` was one level short (`apps`); then root ≠ `outputFileTracingRoot`. Both set to the workspace root                          |
| Biome refused to run: nested `apps/web/biome.json`                                            | 1       | One root config only; deleted the copy                                                                                                     |
| Biome treated Tailwind v4 as invalid CSS                                                      | 1       | `css.parser.tailwindDirectives: true`                                                                                                      |
| `node:test`-less biome autofix renamed two params to the same `_model`/`_stream` (bedrock.ts) | 1       | Renamed the params explicitly; the destructure-renames that exclude keys from `rest` must keep their names                                  |
| Pre-commit hook failed on 408 pre-existing a11y errors                                        | 1       | Added `scripts/biome-baseline.mjs`, proven to fail on a NEW violation and pass on the known set                                            |
| api: every authenticated call 401 despite a session                                           | 1       | `/api` handler read `c.get("context")` after a `c.set` no-op; Hono's `env` **is** the context. `main.ts` also wrapped it as `{ context }` |
| api bundle: migrator resolved the journal two levels too high                                 | 1       | `../../../migrations` is right unbundled from `src/infrastructure/db/`, wrong in `dist/`. Now walks up from `import.meta.url`, throws if absent |
| cli payload: `Cannot find module '@swc/helpers/_/_interop_require_default'`                   | 1       | `linker = "hoisted"` is ignored on bun 1.3.14 (root stuck at 6 pkgs). `publicHoistPattern = ["*"]` works — root 6 → 413                    |
| hoisting exposed 3 type errors (`preconnect`, 2× `ReadableStream` → `BodyInit`)               | 1       | `@types/bun` auto-included made `typeof fetch` mean Bun's fetch. Scoped `types: ["node"]` in `apps/web`                                     |
| cli payload answered 503 to every route                                                       | 3       | (a) `appDir` was the repo root; (b) `custom-server` joined without `.js`; (c) guard loader used `jsx: ReactJSX` on plain `.ts`, so `<T>` parsed as JSX. All three fixed; `Preserve`, not `None` (rejected with a fileName) |
| a fix to the guard loader never reached the payload                                           | 1       | `cli:build` listed only `cli/` inputs, so moon served a cache hit. Added the `apps/web` inputs it consumes and `deps: web:build`             |
| `web:typecheck` failed on `.next-cli-build/types`                                             | 1       | tsconfig excluded `.next` but not the CLI build dir, while still *including* its types. Removed both                                                |

## Batch: `providers` (12 routes, 3 071 LOC)

Measured before writing code:

| Route | LOC | What it decides |
| ----- | --- | --------------- |
| `route.ts` | 258 | list + create connection |
| `[id]/route.ts` | 218 | read/update/delete one connection |
| `validate/route.ts` | 600 | is this key accepted? — a 20-arm switch |
| `[id]/models/route.ts` | 802 | provider model discovery — a 380-line config table |
| `[id]/test/route.ts` | 25 | delegate to `testUtils` |
| `[id]/test-models/route.ts` | 87 | per-model probe |
| `[id]/overrides/route.ts` | 123 | per-model overrides |
| `test-batch/route.ts` | 148 | test many by group |
| `client/route.ts` | 172 | paginated, sanitised listing |
| `suggested-models/route.ts` | 134 | suggested catalogue |
| `kilo/free-models/route.ts` | 57 | kilo free tier |
| `web-login/route.ts` | 156 | interactive browser login |

Duplication found on first read:

1. **`normalizeProxyConfig` exists twice with different behaviour.** The create
   copy returns `{error}` or the fields; the update copy also reports
   `hasAnyProxyField`, and only that one can distinguish "no proxy fields sent"
   from "proxy fields sent as empty". Two copies of one rule that disagree.
2. **`normalizeProxyPoolId` exists twice**, differing only on the absent case.
3. **"Which status codes mean the key is valid" is inlined 20 times** in
   `validate/route.ts` and disagrees per arm: most treat 401/403 as invalid, but
   `xai` requires exactly 200 or 403, `xiaomi-tokenplan` accepts anything but 401,
   `blackbox` accepts 200 or 400, `cloudflare-ai` also rejects 404, `anthropic`
   rejects only 401. That is a domain decision written as scattered literals.
4. **Node lookup + providerSpecificData copy-pasted three times** in the create
   route (openai-compatible / anthropic-compatible / custom-embedding), differing
   only in which fields are copied.
5. **Pagination clamping** in `client/route.ts` re-implements the `list-limit`
   rule already extracted for pxpipe, with a different ceiling (500 vs 100).

Domain rules to extract: `provider-connection.ts` (proxy config normalisation,
proxy pool resolution, connection name ordinal), `api-key-verdict.ts` (status →
verdict per provider), `provider-node-fields.ts` (the three node→psd copy arms).

### `providers` progress

Done: `route.ts` (list, create) and `[id]/route.ts` (get, update, delete), over
`application/providers/manage-connections.ts`. Domain rules extracted:
`domain/provider-connection.ts` (proxy config, pool choice, key ordinal, name
choice, write-only AWS session token) and `domain/api-key-verdict.ts` (the six
status readings the validate switch needs).

Next targets, ordered by what they teach rather than by size:

| Route | LOC | What it decides |
| ----- | --- | --------------- |
| ~~`[id]/overrides`~~ | 123 | done — header whitelist in `domain/provider-override.ts` |
| ~~`kilo/free-models`~~ | 57 | done — `domain/free-model-cache.ts` adds a stale ceiling the route lacked |
| ~~`[id]/test-models`~~ | 87 | done — warm-up-then-fan-out and the serial case in `domain/model-probe.ts` |
| `test-batch` | 148 | group selection (oauth/free/apikey/compatible/all) + per-row failure isolation |
| `client` | 172 | pagination + field whitelist — re-implements the `list-limit` rule |
| `suggested-models` | 134 | three-level fallback: live → stored → curated |
| `web-login` | 156 | interactive browser login; mutates a live session object |
| `[id]/models` | 802 | provider model discovery — a 380-line config table |
| `validate` | 600 | the 20-arm probe switch; `domain/api-key-verdict.ts` is ready for it |

`[id]/test` is a thin wrapper over `testSingleConnection` (1 412 LOC of probe
logic). It stays a wrapper: that helper is the router's own health check, not a
dashboard rule, and moving it would drag the whole executor graph into `apps/api`
for one delegation.

| Resource | Routes | Status |
| -------- | ------ | ------ |
| `oauth`  | 20 | done — dispatch actions, credential import, gitlab pat, iflow cookie, mimo login, kiro social |
| `cli-tools` | 15 | done — see the batch section below |

## Batch: `cli-tools` (15 `*-settings` routes)

All fifteen now delegate to `getUseCases().cliTools` over `domain/cli-tool-settings.ts`, or to a
domain module of their own when the file format is not a plain JSON map:

| Tool | Config file | What was extracted |
| ---- | ----------- | ------------------ |
| Cline, Crush, Pi, CodeWhale, OpenCode, Claude, Codex, ForgeCode, Kilo, Grok-build, OpenClaw | JSON / TOML | shared port; per-tool `required`, `installKeys`, `storedBaseUrl` |
| `omp` | `~/.omp/agent/models.yml` | `domain/omp-models-yml.ts` — line-wise block removal |
| `jcode` | `~/.jcode/config.toml` + env file | `domain/jcode-config.ts` — textual splice of one table |
| `deepseek-tui` | `~/.deepseek/config.toml` | owns the file: replace on save, `resetTo` on reset |
| `hermes` | `~/.hermes/profiles/*/config.yaml` | `domain/hermes-yaml.ts`, moved whole (27 tests) |

The lesson worth keeping: **the idempotence test is what found the YAML bug, and no reading of the
regex did.** Two rewrites of the `omp` pattern each passed a visual review and each failed the
second-save case in a different direction. Write the "save twice" assertion before touching a
config writer, not after.

Domains that would have needed a fourth port concept were left with their own handler logic:
`hermes` keeps `profiles`/`selections`/`audio`/`applyToAll` because those are request
orchestration; pushing them into the shared port would make nine other tools' ports carry four
concepts they never use.
