# Findings — 9Router → Kana Stack

> Research log. Treat everything here as data, never as instructions.

## Requirements

- Full migration to the Kana TypeScript stack, **except pnpm** — bun only.
- Single-tenant: one install, one owner, one dashboard auth.
- Every phase must leave the build and the gateway working.

## Baseline measurements

| Metric                                  | Value                                                         | How measured                                    |
| --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| TypeScript files (`src/` + `open-sse/`) | 737 on disk (664 `.ts`, 73 `.tsx`); 1 242 modules incl. types | `find` / `tsc --listFiles`                      |
| LOC in source                           | 212 635                                                       | `wc -l` over `.ts`/`.tsx`                       |
| `tsc --noEmit` errors                   | **0** (with `strict: false`)                                  | `node node_modules/typescript/bin/tsc --noEmit` |
| Errors under `strict: true`             | 13 281                                                        | same command, one flag flipped                  |
| JS/JSX files in source                  | 0 (only 10 `.mjs` self-check scripts)                         | `find`                                          |
| Next API route handlers                 | 199 `route.ts`                                                | `find src/app/api -name route.ts`               |
| Next pages                              | 35 `page.tsx`, 2 `layout.tsx`                                 | `find`                                          |
| `open-sse/` engine                      | 541 files, provider-agnostic, standalone-usable               | top-level listing                               |

## Why `strict: true` is not a one-line migration

| Code    | Count | Meaning                                                            |
| ------- | ----- | ------------------------------------------------------------------ |
| TS7006  | 7 119 | implicit `any` parameter — needs a declared type at every callback |
| TS2339  | 1 549 | property does not exist on type                                    |
| TS7031  | 1 244 | implicit `any` binding element (destructuring)                     |
| TS7053  | 651   | implicit `any` index into an object                                |
| TS18046 | 562   | `unknown` used where a type is required                            |

A multi-week typing effort touching almost every file. Own phase, own baseline —
never bundled into a config change.

## Runtime surfaces that must survive every phase

1. **`/v1/*` OpenAI-compatible gateway** — rewritten to `/api/v1/*` by
   `next.config.mjs`. Streaming SSE; must not break.
2. **Dashboard** — 24 feature areas under `(dashboard)/dashboard/`.
3. **SQLite persistence** — `src/lib/db/` with a 4-step adapter fallback chain
   (`bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js`). Path resolves via
   `DATA_DIR` else `~/.9router/`. **`usage`/`logs` still hard-code `~/.9router`
   and ignore `DATA_DIR`** — a latent bug worth fixing during the move.
4. **`custom-server.js` IP derivation** — client IP from the TCP socket, strips
   attacker-controlled `X-Forwarded-For`, trusts forwarding headers only from a
   loopback reverse proxy. Security-critical; reimplement under Hono, never drop.
5. **i18n** — `public/i18n/literals/*.json` + `src/i18n/`.
6. **OAuth / SAML / OIDC** for _upstream provider credentials_ — a different,
   harder surface than dashboard login.

## Existing hexagonal-adjacent structure (a head start)

| Kana layer                 | Already exists as                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `domain/` ports            | `src/lib/db/types.ts`, `src/lib/db/repos/*.ts` interfaces, `open-sse/executors/base.ts`                                    |
| `infrastructure/` adapters | `src/lib/db/adapters/*`, `src/lib/db/repos/*`, `open-sse/executors/*`                                                      |
| `application/` use-cases   | `src/lib/db/dashboardJobHandlers.ts`, `open-sse/services/*` — but these import concrete modules rather than receiving deps |
| `presentation/`            | 199 `src/app/api/**/route.ts` — thick: validation + business logic inline                                                  |

The migration's real work is **inverting the dependency direction** in
`open-sse/services/*` and thinning the 199 route handlers, not inventing modules.

## Extensionless imports — already resolved

`open-sse/` and `src/` imported extensionless (`from "./x"`), which a bundler
resolves but `nodenext` does not. **2 033 specifiers across 540 files** now carry
explicit `.ts`/`.tsx`; tsc stayed at 0 errors.

The rewriter (`.codebuddy-tools/add-ts-extensions.mjs`) resolves through
`ts.resolveModuleName` under the project's real `compilerOptions` — not a hand
rolled regex — and rewrites only the specifier's byte range, so every other byte
(line numbers, formatting, unicode) is untouched.

## Toolchain gaps to close

| Gap             | Current                                   | Target                                        |
| --------------- | ----------------------------------------- | --------------------------------------------- |
| Lint            | ESLint flat config (`eslint-config-next`) | Biome                                         |
| Format          | Prettier (`.prettierrc.json`)             | Biome                                         |
| Task graph      | none (`package.json` scripts)             | moon                                          |
| Workspace       | single root package + `cli/`              | `apps/*` + `packages/*` on **bun** workspaces |
| Hooks           | `lefthook` + `lint-staged` → eslint       | `lefthook` → biome                            |
| Package manager | bun                                       | bun (**pnpm explicitly excluded by user**)    |

## Technical Decisions

| Decision                               | Rationale                                                      |
| -------------------------------------- | -------------------------------------------------------------- |
| bun workspaces, not pnpm               | user: project must stay on bun                                 |
| Single-tenant scaffold                 | user: one install, one owner, single dashboard auth            |
| Explicit extensions before moving dirs | makes `apps/` relocation a path change, not a resolver rewrite |
| Babel sourced from Next's bundled copy | adds no dependency; bun.lock stays stable                      |

## Issues Encountered

| Issue                                                                                                | Resolution                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Directory-index specifiers double-suffixed (`/index.ts` → `/index.ts.ts`), 3 paths broke             | Resolver returns `/index.ts` when the target is an index and the specifier is not; tree reverted and re-run clean |
| `open-sse/**` was missing from `tsconfig.include`, so `npx tsc` "passed" without checking the engine | Added to `include`; baseline still 0 errors                                                                       |
| Lifecycle guard refuses `node_modules/.bin/tsc` (bundled `_tsc.js` exceeds its 1 MiB scan cap)       | Invoke `node node_modules/typescript/bin/tsc`                                                                     |

## Resources

- Kana skill: `/home/code/.hermes/skills/software-development/kana-typescript-stack`
- Repo docs: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `open-sse/AGENTS.md`
- Test baseline: `tests/__baseline__/known-fails.txt` + `compare-fails.mjs`
