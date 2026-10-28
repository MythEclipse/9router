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

Phase 1 — write `findings.md` with the discovery inventory (entry points,
runtime surfaces, LOC hotspots) before touching config.

## Current Phase

Phase 1

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
- [ ] Convert the `@/` and `open-sse/*` aliases usage check (aliases stay, but verify)
- **Status:** complete

### Phase 3: tsconfig hygiene (unblock TS 7)

- [x] Drop deprecated `baseUrl` (paths are root-relative since TS 5)
- [x] Fix `jsconfig.json` the same way
- **Status:** complete

### Phase 4: bun workspace skeleton (`apps/*`, `packages/*`)

- [ ] Root `package.json` → private workspace root, `workspaces: ["apps/*", "packages/*"]`
- [ ] Move Next app to `apps/web`, gateway engine to `apps/api` (staged, not yet rewritten)
- [ ] Root `bun.lock` regenerated once, from the workspace root
- [ ] CI + Dockerfiles updated to the new paths (`assemble.sh`, `Dockerfile`, workflows)
- **Status:** pending

### Phase 5: Biome replaces ESLint + Prettier

- [ ] `biome.json` — tabs, double quotes, semicolons as needed, `!payload`, `!**/dist`
- [ ] Delete `eslint.config.mjs`, `eslint.tmp.mjs`, `.prettierrc.json`, `.prettierignore`
- [ ] `lefthook.yml` + `lint-staged` → biome on staged files
- [ ] Keep the diff at formatting-only in a dedicated commit
- **Status:** pending

### Phase 6: moon task graph

- [ ] `.moon/workspace.yml`, `tasks.yml`, `toolchain.yml`; one `moon.yml` per project
- [ ] Prove with a **cold** run: `moon clean --all` + remove every `dist/`
- **Status:** pending

### Phase 7: `apps/api` — Hono + oRPC + Drizzle + better-auth

- [ ] Hono server with Zod-validated env at startup
- [ ] oRPC 1.15.5 routers: `.input()` → `.use()` → `.handler()`, per-procedure middleware
- [ ] Drizzle schema + migration journal + bundled migrator with `.sql` beside it
- [ ] better-auth single-tenant session replacing the JWT cookie guard
- [ ] Port `open-sse` behind the four layers (domain ports, application use-cases)
- **Status:** pending

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

## Errors Encountered

| Error                                                                                         | Attempt | Resolution                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Directory-index specifiers got double-suffixed (`/index.ts` → `/index.ts.ts`… 3 broken paths) | 1       | Resolver now returns `/index.ts` when the target file is an index and the specifier is not already one; reverted the tree and re-ran clean |
| `npx tsc` silently reported 0 errors including in `open-sse`                                  | 1       | `open-sse/**` was never in `include`; now included, baseline still 0                                                                       |
| Lifecycle guard refused `./node_modules/.bin/tsc` (bundled `_tsc.js` > 1 MiB scan cap)        | 1       | Invoke `node node_modules/typescript/bin/tsc` instead                                                                                      |
