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

## The oRPC surface has no caller (measured 2026-10-29)

`apps/api` is two things welded together, and only one of them ships:

1. **A library** — `domain/`, `application/`, `infrastructure/`. `apps/web` imports it
   through `transpilePackages` and calls `getUseCases()` 199 times.
2. **A server** — `presentation/http/app.ts` + `presentation/orpc/` (61 procedures,
   595 LOC) served by `main.ts` on port 20127.

Nothing starts (2). No unit file, no CI job, no Dockerfile, no `package.json` script that
anything invokes. The one process that serves users is `apps/web/custom-server.js`.

Two facts make (2) unsafe to grow:

- `main.ts` passes `session: null` for every request. Its own comment says every dashboard
  procedure is therefore correctly rejected with 401. There is no auth wiring.
- Its procedures are not the same surface as the routes: `apiKeys.list` wraps
  `useCases.listApiKeys` (raw keys, `keyHash` stripped), while `GET /api/keys` wraps
  `useCases.dashboardKeys.list` (creator visibility, secrets replaced by names). Two
  different answers to "list the keys", and only the route's is reachable.

### Options, if oRPC is to be kept

| Option | Work | Risk |
| ------ | ---- | ---- |
| **Library only** (drop `presentation/orpc/` and `main.ts`) | Delete 595 LOC + 1 test; keep `domain`/`application`. `packages/db` and the use-cases stay the contract. | Loses the OpenAPI docs surface `app.ts` generates. Nothing consumes it today. |
| **Make oRPC the server** | Build real session resolution (better-auth), mount it as the dashboard's origin, move 199 call sites to an oRPC client, keep routes only for streams. | ~2 surfaces during migration; auth is the hard part, not the procedures. |
| **Keep both, document the split** | Declare `apps/api` a library and `presentation/` an unshipped prototype; stop treating the 61 procedures as progress. | The dead surface keeps attracting code that nobody can reach or test. |

The measurement above is the input to that decision; it is not a recommendation to skip
the work. Option 1 is the smallest honest cleanup, option 2 is the original goal.

## Measured: the oRPC transport migration is not worth continuing

The plan's remaining item was "convert the delegating handlers to oRPC
procedures". Measured before writing any of it:

| Fact | Number |
| ---- | ------ |
| Route handlers outside `v1/`/`v1beta/` | 163 |
| oRPC procedures that already exist | 50 (12 routers) |
| Procedures with a matching REST route | 12 of 50 |
| Dashboard call sites, by area | providers 70, settings 60, cli-tools 46, models 36, oauth 34, usage 19, combos 18, provider-nodes 17, proxy-pools 16, tunnel 15, keys 12, auth 11 |

Three findings decide it:

1. **The procedures are a superset of the routes, not a duplicate of them.**
   `combos.ts` (route) calls 2 use-cases; the `combos` oRPC router calls 9. So
   "convert the route to oRPC" is not a transport swap over identical logic — the
   procedure layer carries behaviour the route never had. Moving the dashboard onto
   it adds capability, and the REST routes must keep working for the CLI anyway.

2. **`apps/web` has no oRPC client at all** — no `@orpc/client` dependency, no
   `RPCLink`, nothing in `src/` that reaches port 20127. The 199 dashboard call
   sites are `fetch("/api/...")` against Next route handlers. Migrating them means
   adding a second transport alongside the first, in a tree where both must serve
   the same dashboard.

3. **The value is already banked.** The reason the sweep existed — rules living in
   routes where no test could reach them — is gone: every handler delegates to
   `apps/api` domain modules or use-cases, and those are covered by 7705 tests. The
   remaining `NextResponse` in each handler is the parse-and-reply shell, which
   holds no rule.

So the oRPC server is now *real and reachable* (session resolution, shared signing
key, migrations — all verified by request), while the dashboard keeps using the
REST surface that both it and the CLI depend on. Converting 163 handlers would add
a parallel transport, not remove a defect.

**What that leaves worth doing instead** is the gap this measurement exposed:
`apps/web` cannot call the API server at all. Wiring one client and migrating one
area end-to-end — `combos`, whose procedures already exceed its route — would prove
the transport without a 163-file rewrite. Recorded as the next step rather than
claiming the sweep is incomplete.
