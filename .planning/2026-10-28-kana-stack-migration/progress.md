## Strict typing debt closed (packages/db + packages/pricing)

`packages/db` now compiles under full `strict`, not just `noImplicitAny` — the
original target — and `apps/api` and `apps/web` are at 0 errors too. Biome
baseline dropped 443 → 426.

Two real defects came out of it, neither fixable by annotation:

| Defect | Consequence |
| ------ | ----------- |
| `run/get/all` declared as rest tuples, called with arrays | contract mismatch between adapter and drivers |
| two different `ModelPricing` types, same name, two packages | collision on import |

The `sql.js` typings question has a third answer worth remembering: not
`@types/bun` (redefines `fetch`), not a local cast at each call site, but a
minimal ambient declaration shipped with the package plus an `include` entry in
every consumer's tsconfig. Ambient declarations do not travel with `import`.

### Delegate accounting

Parallel children earned their cost here only for the mechanical files. Four
coordination failures, all self-inflicted:

| Failure | Fix applied |
| ------- | ----------- |
| child overwrote my adapter fix | never share a file with a child |
| 35 phantom errors | never measure while a child writes |
| tightened type broke untouched consumers | give the child the error text, not the fix |
| child left 8 files unformatted | run biome before measuring |

The one that actually cost time: a child reported `proxyPoolsRepo` clean while
`apps/web` was red, because it never compiled its own consumers. A child's
report is a claim; only my own `tsc` run is evidence.

# Progress Log

## Session: 2026-10-28

### Current Status

- **Phase:** 7 complete (api-key vertical slice); Phase 8 blocked on a decision
- **Started:** 2026-10-28
- **Branch:** `migrate/kana-stack`

### Actions Taken

- Phases 1–6 completed (discovery, explicit import extensions, tsconfig hygiene,
  bun workspace, Biome, moon).
- Phase 7: `apps/api` scaffolded and wired — Hono + oRPC + Drizzle, four layers,
  migrator bundled with its `.sql` journal, 10 tests over real HTTP.
- Cold-tree build made green: `moon clean --all` + every `dist/` removed →
  6/6 tasks, 574M CLI payload, gateway serves.

### Test Results

| Test                                     | Expected      | Actual                | Status |
| ---------------------------------------- | ------------- | --------------------- | ------ |
| `apps/api` suite (`bun test tests/`)     | 10 pass       | 10 pass, 0 fail       | pass   |
| `api:typecheck`                          | 0 errors      | 0 errors              | pass   |
| `web:typecheck`                          | 0 errors      | 0 errors              | pass   |
| `moon run :build` from cold tree         | 6/6 tasks     | 6/6, 574M payload     | pass   |
| Bundled API from `/tmp` (cwd-independent) | 7 tables      | 7 tables created      | pass   |
| Bundled API with `migrations/` removed   | refuses start | throws, no server     | pass   |
| Packaged CLI `/login`                    | 200           | 200                   | pass   |
| Packaged CLI `/dashboard`                | 307           | 307                   | pass   |
| Packaged CLI `/v1/models` (no key)       | 401           | 401                   | pass   |
| Packaged CLI `/api/health`               | 200           | 200                   | pass   |

### Errors

| Error                                                     | Resolution                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Every authenticated oRPC call returned 401                | Hono's `env` **is** the context; removed the `c.set`/`c.get` no-op and the `{ context }` wrapper in `main.ts` |
| Migrator found an empty journal in the bundle             | `../../../migrations` overshoots in `dist/`; walk up from `import.meta.url`, throw when absent |
| CLI payload: `Cannot find module '@swc/helpers/...'`      | `linker = "hoisted"` ignored on bun 1.3.14; `publicHoistPattern = ["*"]` works |
| 3 type errors exposed by hoisting                         | `@types/bun` auto-include made `typeof fetch` mean Bun's; scoped `types: ["node"]` |
| CLI payload answered 503 to every route                   | `appDir` was the repo root; `custom-server` joined without `.js`; guard loader applied ReactJSX to `.ts` |
| Guard loader rejected `jsx: None`                         | With a `fileName` supplied TS requires a real jsx value; use `Preserve` for `.ts` |
| A guard-loader fix never reached the payload              | `cli:build` listed only `cli/` inputs; added the `apps/web` inputs and `deps: web:build` |
| `web:typecheck` read `.next-cli-build/types`              | Excluded the dir in tsconfig and dropped it from `include`                     |
| Stale background jobs left `.next` (876M) at the repo root | Removed; root `.next/` is gitignored but the stale job predates the `apps/web` move |

### Notes for the next session

- Two stale background jobs (`bun run build` from the repo root, and a
  `git checkout -- src open-sse cli`) completed during this session. Both are
  no-ops on the current tree because those paths moved to `apps/web/`; the build
  one still dropped a 876M `.next` at the root, since cleaned.
- The CLI build rewrites `version` in the root and `apps/web` `package.json` as a
  side effect. Restore them before staging so the bump does not ride along in a
  fix commit.

## Phase 8 — port route handlers to oRPC

### Findings before writing code

| Finding | Evidence | Consequence |
| ------- | -------- | ----------- |
| 162 of 199 handlers are port targets | 25 are `v1`/`v1beta` (public OpenAI/Gemini contract), 12 stream or return binary | Porting all 199 would break external tools and `res.json()` destroys binary bodies |
| The dependency closure is 304 files / 51 640 LOC | BFS over `@/` and `open-sse/` imports from the 162 `route.ts` | This relocates the backend; it is not a transport swap |
| `open-sse/` (43 files) sits inside that closure | same BFS | Moving it cuts the gateway that production serves on 20128 |
| ~30 test files import `GET`/`POST` straight from `route.ts` | `grep 'import { ... } from ".../route"' tests/unit` | Every ported handler breaks its tests at once; they must move together |
| `apps/web` has no oRPC client at all | no `src/lib/rpc.ts`, no `@orpc/*` dependency, no usage in `src/` | Client, contract and transport all have to be built, not migrated |

### oRPC behaviour confirmed by running the server

| Behaviour | Detail |
| --------- | ------ |
| Procedures are **POST**, not GET | `GET /api/system/health` → 404, `POST` with `{}` → 200. `OpenAPIHandler` does not infer GET for input-less procedures |
| OpenAPI spec lists bare paths | `/system/health`, not `/api/system/health` — the `prefix: "/api"` is applied at match time, not in the generated document |
| The docs page and spec are reachable | `GET /api/docs` → 200, `GET /api/spec.json` → 200 |

### Slice 1 — `system` (health, changelog) — done

Files: `application/changelog.ts`, `infrastructure/changelog-source.ts`,
`presentation/orpc/routers/system.ts`, `schemas.ts`, `dependencies.ts`,
`use-cases.ts`, `main.ts`, `infrastructure/env.ts`, `tests/changelog.test.ts`.

- `loadChangelog` treats a missing file, an unreachable upstream and a blank
  body as *absent*, never as an error; `ok` is false only when both are absent.
- 6 new tests pin that matrix; suite is **16/16**.
- Verified live: `POST /api/system/changelog` → `{ok: true, official: "# v0.5.111…", custom: null}`
  (`apps/web` has no `CHANGELOG.md`, which is the expected null).
- New env var `WEB_APP_DIR` (default `apps/web`) locates that `CHANGELOG.md`.
- `NODE_ENV=production` without `BETTER_AUTH_SECRET` still refuses to start —
  the env gate fired during testing exactly as designed.

### Notes for the next session

- Edit files with `patch`, not `write_file`: the tool output redacts
  `ReturnType<typeof ...>` to `***`, which looks like disk corruption but is not
  (`'***' in src` is `False`). `python3 -c` is the reliable way to read such a line.
- `apps/api` uses extension-ful relative imports (`../application/x.ts`); a
  `../../` from `src/infrastructure/` escapes `src/` and fails to resolve.

### Slice 2 — extract `packages/db` + `packages/pricing` (option C)

User chose option C: move the shared layers into `packages/` so both apps consume
one source of truth, instead of running two DB layers side by side.

**Measured before moving** — the three candidates turned out far less entangled
than the closure walk suggested:

| Area            | Files | LOC     | imports escaping it |
| --------------- | ----- | ------- | ------------------- |
| `src/lib/db`    | 50    | 9 408   | 12                  |
| `src/lib/auth`  | 8     | 1 146   | 6                   |
| `open-sse`      | 528   | 100 025 | 11                  |

25 cross-boundary imports in total, all pointing at eight small modules — so the
extraction is a move plus a rewrite, not a redesign.

**Done**

- `packages/db` — the SQLite layer (50 files) moved by `git mv`, exposed as
  subpath exports (`./*`, `./repos/*`, `./helpers/*`, `./adapters/*`).
- `packages/pricing` — `open-sse/providers/pricing.ts` (1 324 lines, zero
  imports) moved here because both `packages/db` and the gateway need it, and
  neither should own the other.
- Six zero-dependency modules moved into `packages/db/src/shared/`:
  `keyEndpoints`, `pluginKeys`, `keyAccess`, `keyAccessConstants`,
  `permissionPaths`, `dataDir`. Two shared the name `keyAccess`; the constants
  one was renamed `keyAccessConstants` rather than left ambiguous.
- 48 files in `apps/web` rewritten from `@/lib/db/*` to `@9router/db/*`.
- **`importJobs.ts` no longer imports back into `apps/web`.** Its two dynamic
  imports were post-import refresh hooks; it now exposes
  `registerPostImportHooks()` and `apps/web/src/lib/db/registerPostImportHooks.ts`
  fills them in. An app with no such hooks (the API) leaves them unset.
- `dashboardJobHandlers.ts` and `proxyImportJobs.ts` were moved *back* to
  `apps/web/src/lib/db/` — they call upward (one even imports a route handler
  and `@/models`), so they were never database code.
- `apiKey.ts` moved to `packages/db/src/shared/`; it had one consumer, inside
  the package.
- `@types/bun` is scoped to `packages/db` only (it hosts the Bun adapter), not
  hoisted globally — hoisting it was what once made `typeof fetch` mean Bun's.

**Verified**

- `packages/pricing`, `packages/db`, `apps/api`, `apps/web` — all four typecheck
  clean.
- `bun install` links `@9router/db` and `@9router/pricing` into the workspace.

### Slice 3 — `packages/auth` (7 files, 1 146 LOC)

- 43 consumers in `apps/web` repointed from `@/lib/auth/*` to `@9router/auth/*`.
- The package has **zero** imports escaping it once `@/lib/localDb` became
  `@9router/db`.
- `lib` set to `["DOM", "DOM.Iterable", "ES2022"]` to match `apps/web`. Dropping
  to `node` alone failed `oidc.ts` on `RequestInit.cache` and on `res.json()`
  returning `unknown` — the code is correct, the type surface was narrower.

### Traps hit during the extraction

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `packages/auth`: `Cannot find module 'bun:sqlite'` | it typechecks *through* `packages/db` sources, whose Bun adapter imports `bun:sqlite` | declared the module shape in `packages/db/src/bun-sqlite.d.ts` and added it to auth's `include` |
| `oidc.ts`: `'cache' does not exist in type 'RequestInit'` | `@types/bun` in a package redefines `fetch` globally | removed `@types/bun` from `packages/db` and `packages/auth`; only `bun:sqlite` is declared, by hand |
| Every route answered **503** in the standalone build | the guard loader only resolved `@/` and `open-sse/`, so `@9router/auth/...` failed to load and the guard failed closed | added a `@9router/*` branch to `apps/web/scripts/auth-guard-hooks.mjs` |
| The 503 persisted after that fix | `copy-standalone-assets.mjs` had copied `src/` *before* `packages/auth` existed, so the payload held a stale `dashboardGuard.ts` | rebuild; the script `rmSync`s each destination first, so a fresh build is enough |

### Lesson worth keeping

A green `next build` proves nothing about the payload: the run that produced the
503 exited 0. The guard fails **closed** by design (503 rather than serving
unauthenticated), which is right, but it means the build must be verified by
booting `.next/standalone/custom-server.js` and curling a route — which is how
all three of these were caught.

## noImplicitAny pass — `packages/db` (partial: the 8 named repos)

Measured baseline with `node node_modules/typescript/bin/tsc --noEmit -p packages/db/tsconfig.json --noImplicitAny`:

| Scope | Errors |
| ----- | ------ |
| The 8 named files | **108** (20/18/16/15/11/10/9/9 — matches the brief exactly) |
| Everything else in `packages/db` + `packages/pricing` | **182** across 27 files |
| Total | **290** |

So annotating only these 8 **cannot** make `packages/db` pass `noImplicitAny`;
the flag is a whole-program setting. The remaining 182 are clustered in
`dashboardJobs` (19), `shared/permissionPaths` (18), `packages/pricing/index`
(15), `helpers/metaStore` (10), `adapters/nodeSqliteAdapter` (10), `adapters/sqljsAdapter` (9),
`backup` (7), `notificationsRepo` (7), `securityLogRepo` (7).

Root cause, in one line: repos call `db.get(sql)` / `db.all(sql)` and reach into
`row.x` without passing a row type. `DbAdapter.get/all` already default `T` to
`DbRow` (`Record<string, unknown>`), so the params go implicit-any at `.map(rowToNode)`
rather than the row access. The fix is to type the row-to-domain mappers and
push the row type through every `.map`.

Second cluster: `Object.fromEntries` / `[...]`-shaped literals and `{}` initialised
caches widen to `any`, hitting TS7018/TS7034/TS7053. Those want an explicit
interface, which is also what makes the cache's contents self-documenting.

Third cluster: `apiKeysRepo` reads `global._apiKeyRateLimits` / `global._apiKeyListCache`
which are **not** declared in `globals.d.ts` (only the 8 that were already needed).
Adding them there is the fix the file's own header comment already prescribes.

### Strict-mode debt in `packages/db` (in progress)

`strict: true` on `packages/db` reports the parameters the package never
annotated. Worked file by file, one commit each, verifying behaviour with the 16
API tests plus an `apps/web` typecheck after every file — because these files are
runtime code shared by both apps, not dead annotations.

| File | Errors | State |
| ---- | ------ | ----- |
| `migrate.ts` | 29 | done — `b1b6ff889` |
| `repos/usageRepo.ts` | 51 | done — `50f91c041` |
| `repos/modelEditorRepo.ts` | 26 | done — `80fe30ea7` |
| `jobStore.ts` | 11 | done — now generic over the job record |
| `importJobs.ts` | — | done |
| `importJobAuth.ts` | — | done |
| `dashboardJobs.ts` | — | done |
| `proxyImportJobs.ts` (web) | — | done |
| 8 repo files (alias, requestDetails, apiKeys, pricing, combos, nodes, settings, allowedModels) | -> 0 | done |
| `shared/permissionPaths.ts`, `helpers/metaStore.ts`, both sqlite adapters | -> 0 | done |
| remaining | 85 | pending |

### Correction: `apps/api` strict errors were pre-existing, not a regression

`apps/api` under `strict` reports 60 errors in `packages/db` even with
`packages/db` restored to HEAD. They were invisible before because the oRPC
`settings` port (uncommitted, from the previous session) widened what `apps/api`
imports. A worktree at HEAD reports 0 only because nothing there pulls those
modules in. Do not read "HEAD is green" as "this work broke it" — measure with the
same import graph.

Measuring this cost three wrong readings in a row, each from a different flaw:
- a stashed measurement that did not stash (`git stash -i` is not a flag)
- a worktree whose `node_modules` symlink did not resolve
- attribution to `sql-js.d.ts`, disproved by removing it

Lesson: verify the baseline with the *same* command in the *same* shape before
calling something a regression.

Two traps worth keeping:

1. **Redacted tool output is not file content.** String values in these files can
   display as `***` in terminal output. Matching that text in a script fails, and
   "repairing" it corrupts a correct file. Read the file, never match what the
   terminal showed.
2. **Typing surfaces real bugs.** `modelEditorRepo` trimmed `displayName` and
   `targetLabel` without a type guard on JSON read back from kv — a numeric value
   would have thrown. `dashboardJobs` writes status `"cancelled"` that its own
   type omitted. Annotations are not cosmetic here.

### noImplicitAny pass — the 8 repos (done)

All eight named files are clean under `--noImplicitAny`: **108 → 0**. Whole-package
total went **290 → 93**, so the package still does NOT pass the flag; the
remaining 93 were never in scope. That list is in the section above.

### The mistake worth remembering

Typing `Settings.comboStrategies` as `Record<string, unknown>` was *worse than
`any`*. `any` propagates silently; `unknown` propagated as 26 hard errors in
`apps/web` (`chat.ts`, `sse/services/auth.ts`, the combo handlers). A type
annotation on a shared interface is a change to every consumer's contract: the
field has to be named by what consumers do with it (`ComboStrategy.fallbackStrategy`,
`ProviderStrategy.rotateStrategy`), not by the fact that the raw row is
untrusted. `[key: string]: unknown` stays as the escape hatch; the known fields
carry real types.

Same lesson for `CustomPluginSetting.models`: `unknown[]` broke two routes that
read it as `string[]`. Plugin model lists are model ids — it is `string[]`.

### Cross-package check (do this every time)

`packages/db` typechecks fine on its own even when it breaks `apps/web`, because
`-p packages/db/tsconfig.json` resolves `@9router/pricing` through `paths` and
never looks at the consumers. Verified `apps/web` clean at HEAD (0 errors) via a
detached worktree, then re-checked after each fix:

| Stage | apps/web errors |
| ----- | --------------- |
| HEAD (clean baseline) | 0 |
| after first `Settings` draft | 35 |
| after `ComboStrategy`/`ProviderStrategy` | 11 |
| after `AutoPing`, `password`, `customPlugins` | 3 |
| after call-site narrowing | **0** |

Two `Settings | {}` fallbacks (`getSettings().catch(() => ({}))`) were the last
holdouts: the `{}` branch is not a `Settings`, so `settings?.customPlugins` was a
union. Narrowed at the call site with `.catch(() => null)` instead of widening
the interface.

### Batch 2 landed — `5b277902f`

`packages/db` strict debt: 377 → 85 remaining. Both apps green
(`apps/web` 0), 16 API tests pass, `bun run build` succeeds, production smoke
test on port 20196 answered `/login` 200, `/dashboard` 307, `/v1/models` 401,
`/api/auth/status` 200 with all five migrations applied.

Four real defects came out of the annotations — none visible while the
parameters were implicit:

| Where | Defect | Would have |
| ----- | ------ | ---------- |
| `modelEditorRepo` | `.trim()` on unguarded kv JSON | thrown on a numeric `displayName` |
| `dashboardJobs` | wrote status `"cancelled"` missing from its type | — (type-only) |
| `login/route.ts`, `auth/dashboardSession.ts` | `bcrypt.compare` promise assigned to `boolean` | always-truthy auth branch |
| `usageRepo` | `lastUsed` declared on sub-interfaces, not the base | undeclared writes in `byApiKey`/`byEndpoint` |

Remaining 85 live in files this batch did not touch (`backup.ts`, `version.ts`,
the numbered migrations, `securityLogRepo`, `notificationsRepo`, ...). Note that
`apps/api` under full `strict` sees 60 of them because it imports more of the
package than `apps/web` does — that is the debt showing, not a regression.

### Batch 3 (in progress): adapters + the tail of the package

Both sqlite adapters are done and verified. The interesting part was not the
parameters but the contract: `betterSqlite3` and `bun:sqlite` declare
`run/get/all` with a **rest tuple**, while `ResolvedDbAdapter` passes a plain
`DbParams` array. Spreading an array into a rest-tuple signature is a type error,
so `better-sqlite3` goes through `Function.apply` and `bun:sqlite` casts to its
own value union. Both then narrow the driver's `unknown` result to the declared
generic, exactly as `nodeSqliteAdapter` already did.

Delegate coordination is the real cost here, and it bit twice:

| Symptom | Cause |
| ------- | ----- |
| 35 phantom `apps/web` errors mid-run | measuring while a child wrote `settingsRepo.ts` |
| `betterSqliteAdapter.ts` silently reverted | the child rewrote the file after I had fixed it |
| 5 errors in `proxyPoolsRepo.ts` | child tightened `createProxyPool`, consumers not yet updated |

Rule adopted: a child must never be given a file I am also editing, and no
measurement counts while a child is running. Steer the child with the exact
error text instead of patching its file from the outside.

### Batch 3b landed: `backup.ts` + the five numbered migrations

All seven files in this batch (`backup.ts`, `migrations/001`–`005`, and the
`migrations/index.ts` contract that types the chain) report **zero** errors
under `tsc -p tsconfig.p.json`. Baseline going in was 22 `TS7006`s across the
six; the package total is now 0.

The annotation produced one type-only change and one structural one:

| Where | Change | Effect |
| ----- | ------ | ------ |
| `backup.ts` `backupFile` | return type `string \| null` | the `null` branch of "source does not exist" is now visible to callers |
| `backup.ts` `backupDbLite` | `.all<TableCopyPlan>(…)` | `t.sql`/`t.name` are no longer `any` |
| `migrations/index.ts` | new exported `Migration` interface | see below |
| `004` | `TableNameRow`, `005` | `TableColumnInfo` row shapes; PRAGMA/`sqlite_master` reads stop being `any` |

`Migration` is the one piece of real design. Before, each numbered file was an
unannotated object literal and `MIGRATIONS` was inferred as a structural
`{version, name, up(db)}[]` — the shape existed, unnamed, and nothing checked a
new migration against it. Naming it gives the chain a contract a new file is
typed against, and `MIGRATIONS: Migration[]` pins the registry.

#### Verification, not just a green tsc

`backupDbLite` and the migrations are executable, so the annotations were
proven behaviourally as well as statically — a sandboxed `DATA_DIR` on the real
`bun:sqlite` adapter, 10 checks: chain sorts ascending, `latestVersion()` is 5,
all five migrations apply and stamp, `001` creates every `TABLES` entry, `005`
adds `allowedEndpoints`, and a `backupDbLite` file excludes `requestDetails`
while keeping `providerConnections`. All passed; scratch file removed.

The pre-existing `tests/unit/db-migration-*.test.ts` and
`request-details-tab.test.ts` import `@/lib/db/...`, which resolves to
`src/lib/db` — a directory that no longer exists since the move to
`packages/db`. Those six tests fail on module resolution and are **not** a
result of this change; they need repointing at `@9router/db` before they can
guard anything.

#### Process note

I hit the documented multi-agent hazard first-hand: measuring `apps/web` while
the child rewrote `proxyPoolsRepo.ts` produced a drifting error count (5 → 3 →
5) and briefly suggested my own change had caused adapter errors it had not.
A `git stash push`/`pop` round-trip was used to isolate it and was clean, but
on a tree another agent is writing, prefer a frozen copy over stashing shared
state.


### `packages/db` type-annotation batch — back to zero

`packages/db` now reports **0** errors under both `tsconfig.json` (full) and
`tsconfig.p.json` (`noImplicitAny`), and `apps/web` stays at 0.

Files annotated this batch: `backup.ts`, `version.ts`, `index.ts` (summary +
`importDb`), `helpers/nullBytes.ts`, `shared/apiKey.ts`,
`shared/keyAccessConstants.ts`, all five numbered migrations + `migrations/index.ts`
(new `Migration` interface), and the repos `autoBackupRepo`, `connectionsRepo`,
`disabledModelsRepo`, `errorLogRepo`, `notificationsRepo`, `proxyPoolsRepo`,
`securityLogRepo`, `settingsHistoryRepo`.

Real defects the annotations exposed (all fixed):

| Where | Defect |
| ----- | ------ |
| `securityLogRepo.getSecuritySummary` | `logins` literal had no `viaApiKey` field but the body incremented it — the summary returned `NaN` |
| `disabledModelsRepo` | `parseJson(row.value, [])` on an untyped row read the *row object*, not its `value` column |
| `proxyPoolsRepo.createProxyPool` | returned an object literal whose fields came from `unknown`; now built from a declared `ProxyPoolInput` |
| `betterSqliteAdapter` | `.apply()` bridged DbParams to a rest tuple; replaced with an explicit tuple spread |

Consumers narrowed in `apps/web` (parent-owned): `telegramBackup.ts` reads
`AutoBackupStatus.lastSentAt`; `proxy-pools/route.ts` passes its
`ProxyPoolInput`. `packages/db` exports both types (`AutoBackupStatus`,
`ProxyPoolInput`) so the two apps share one shape.

Note: `apps/api`'s own `tsconfig` (full `strict`) still reports 12 diagnostics
that land in `packages/db` (`migrate.ts`, `shared/dataDir.ts`, `sqljsAdapter.ts`).
None are implicit-`any`; they are the next layer of strict debt.

Update on the same batch: `apps/web` flipped to 1 error the moment
`getPricingForModel` stopped returning `unknown`, because `arena/page.tsx` feeds
it to `calculateCostFromTokens`. Fixed at the source: `packages/pricing` now
exports `ModelPricing` (optional `cached`/`reasoning`/`cache_creation`, matching
the real catalog where several entries omit them), `getPricingForModel` returns
`ModelPricing | null`, and `packages/db/repos/pricingRepo.ts` aliases that same
type instead of its own `Record<string, number>`. One shape, three packages.

Final: `packages/db` 0 under full and `noImplicitAny`, `apps/web` 0,
`apps/api` 16/16 tests pass.

## Test suite green (2026-10-28)

`bun run test`: **5496 passed, 81 skipped, 0 failed** (was 980 passing /
481 failing before the migration fixes; 5291/33 at the start of this pass).

Failure classes, in the order they surfaced — each was a different way a test
could assert nothing while reading as coverage:

1. **Dead import paths (530 files)** — module imports still pointed at the
   pre-monorepo tree (`../../src`, `../../open-sse`, `@/lib/db`). Tests could
   not resolve the module at all.
2. **Closed mocks (39 files)** — `@/lib/localDb` was mocked with an object
   literal, which erases every export it does not name. Adding a
   `getStudioModels` call site silently dropped the route onto its fallback
   branch. Mocks now spread `importOriginal()` and override only what the test
   drives.
3. **Mocks on the wrong specifier (2 files)** — `@/lib/auth/...` and `@/lib/db`
   mocked while the code imports `@9router/auth/...` and `@9router/db`. The mock
   never applied, so the test asserted against the real implementation.
4. **Format-sensitive assertions (~12 tests)** — `toContain` on literals ending
   in `;` against sources formatted without semicolons; regexes pinning two
   spaces of indentation against tab-indented files; `};` to close an object
   that ends `}`; a single-line call now spread across lines. Each reported a
   missing feature (`expected '' to contain ...`) when the feature was intact.

Real product bugs found by the suite:

- `getPricing` iterated only `PROVIDER_PRICING`, dropping providers priced by
  the user alone (custom endpoints, local models). `getPricingForModel` handled
  that case, so the two readers disagreed. Fixed in `packages/db`.
- `resolveStandaloneBuild` picked its entry filename by testing whether the
  *legacy* `.next/standalone` existed. The CLI build writes `.next-cli-build`,
  so it looked for `custom-server.js` when the build had `server.js` and
  declared a good build missing. Both names are probed now.
- `antislopPrompt.ts` was stale against its sources; regenerated.

Verification: `packages/db` and `apps/api` typecheck 0, `biome check` 426 errors
against the 443 baseline, `bun run build` exit 0, standalone gateway answers
`/login` 200, `/dashboard` 307, `/api/auth/status` 200, `/v1/models` 401.

## Phase 8 — combos resource ported (first of 168)

Ported the four combos route handlers (390 LOC) to use-cases in `apps/api`,
leaving the Next routes in place as thin delegates.

**Where the rules went.** `apps/api/src/domain/combo.ts` holds the parts that
are pure — name validation, context-window reads, cycle detection. The use-case
in `application/combos/manage-combos.ts` takes `ComboPort` / `StudioTargetPort` /
`ComboRotationPort` by constructor, so the rules are testable without a server.
`infrastructure/use-cases-factory.ts` is the single composition root shared by
`apps/api/main.ts` and `apps/web/src/lib/useCases.ts`.

**Three bugs the port exposed, all invisible until the standalone was run:**

1. `next.config.mjs` did not list `9router-api` in `transpilePackages`, and the
   package ships TypeScript. Turbopack compiled the callers and dropped the
   callee, so every delegating route threw module-not-found at runtime while
   `bun run build` reported success.
2. `runMigrations` located its journal from `import.meta.url`. Turbopack rewrites
   that to a workspace-relative string (`e.F("apps/api/src/...")`), so the ascent
   walked a path that does not exist and the migrator refused to start. It now
   accepts an explicit `migrationsDir`, and the web host passes
   `join(process.cwd(), "migrations")` — the location the standalone build
   stages. Guessing is gone.
3. `apps/api`'s db client imported `bun:sqlite` at module scope despite its own
   header promising a four-step fallback. Any Node consumer failed to load the
   module graph at all. It now throws a named error on non-Bun hosts pointing at
   `@9router/db`'s driver, which owns the real fallback chain.

**Test harness.** `tests/vitest.config.ts` gained a `bun:sqlite` resolver — Vite's
alias table never sees a `bun:` specifier, the ESM loader rejects it first, so
resolution needs a plugin. `combo-duplicate.test.ts` was rewritten to stub
`@/lib/useCases` instead of `@/lib/localDb`, because the route no longer touches
`localDb` directly; it asserts the same behaviour (copy naming, carried strategy
without aliasing, 404) against the use-case boundary.

**Verification.** `apps/api` and `apps/web` typecheck 0. `biome check` clean on
every touched path. Suite: 5528 pass, 0 fail (was 5522 — the six recovered are
the duplicate tests). Twelve test *files* still fail to collect; they reference
pre-migration paths (`custom-server.ts`, `apps/web/open-sse/`) and fail
identically on a stashed tree, so they are backlog, not regressions. Standalone
smoke on a fresh `DATA_DIR`: `/api/combos` create 200, list 200, invalid name
400, `/login` 200, `/dashboard` 200, `/api/auth/status` 200, `/v1/models` 401.

Remaining: 164 of 168 route handlers.

## Session 2 — the test gate, then four more resources

### The gate first

Before porting anything else I fixed the twelve test files that failed at
collection. A collection failure reports **zero tests, not a failed assertion**,
so it passes any gate that counts failures — twelve files of coverage had been
absent since the monorepo split and nothing said so.

Three distinct causes, not one mechanical rename:

- Stale module paths (`keyEndpoints`/`keyAccess` → `packages/db`, `loginLimiter`
  → `packages/auth`, `custom-server` and `copy-standalone-assets.mjs` →
  `apps/web`).
- `path.resolve("../../...")` anchored to **CWD**, not the file. Under
  `vitest --root tests` the CWD is the repo root, so the prefix escaped the
  repository and the error named `/home/code/apps/web/...`. Now anchored on
  `import.meta.url`.
- Assertions written against the old formatter: two required trailing
  semicolons (this repo formats without them) and two scanned for a
  single-line `appendRequestLog({ … status: … })` that the formatter now
  spreads over several lines. The line scan matched **zero call sites** and
  asserted nothing — it would have stayed green through any regression in the
  lifecycle rows. Now matched as whole call expressions.

Result: 560 files, **0 failures**, 5522 → 5675 tests.

### Resources ported

| Resource | Rule extracted | Defect fixed |
| --- | --- | --- |
| `error-logs` | `resolveErrorLogLimit` — total, reports `adjusted` | a failed clear answered `success: true` |
| `theme` | `refuseThemeWrite` — 401 vs 403 kept distinct | (none; the two codes were already right, just unnested) |
| `locale` | `resolveLocale` — exact tag before primary subtag | `de-AT` was a 400; `pt-BR` could collapse to `pt` |
| `pricing` | `parsePricingUpdate`, `parsePricingResetTarget` | **`?model=` alone reset every override**; PATCH accepted a row missing `input`/`output` |

`error-logs` also cost a real move: `toResponse` lived in `api/combos/response.ts`
and the second caller proved it belonged in `api/response.ts`.

### Found while working

- `apps/api` typechecked with **one** pre-existing error: `packages/pricing`
  passed a possibly-`undefined` value from `split("/").pop()` into
  `matchPattern`. Fixed with `?? model`; the package is now clean.
- `pricing/route.ts` exported a `GET_DEFAULTS` handler that Next never routes —
  dead since it was written. Removed.
- **`tags` is deliberately not ported.** It returns one hardcoded catalogue
  (`ollamaModels`) and has no rules; moving it would create empty layers and
  inflate the count. Recording this so a later pass does not "finish" it.

### Verification

Per resource: `tsc` clean on both packages, `biome check` clean, domain +
use-case tests with fakes, then a standalone smoke on a fresh `DATA_DIR`
covering the happy path, each rejection, and the destructive path. Gateway
baseline unchanged throughout (`/login` 200, `/v1/models` 401).

Final: 567 files, 554 passed, 13 skipped, **0 failed**, 5726 tests.

### `keys` (3 routes)

- Sub-key scoping is `domain/sub-key-scope.ts`. The endpoint kinds and the
  model-pattern matcher are injected from `packages/db`; the first version
  reimplemented both and got both wrong (dropped `*suffix` patterns; guessed
  an endpoint list missing `responses` and `models`).
- `domain/key-ownership.ts` puts read and write verdicts in one place. PUT and
  DELETE had written the same four checks twice, in a different order, so the
  same caller saw a different error per verb.
- `domain/bulk-key-edit.ts`: `parseBulkPatch` returns a rejection for a
  non-object body. The route read `.error` off a `null`, so a malformed patch
  was a 500.
- Adapter defect caught by smoke, not by tests: `createApiKey` returns the row,
  and the row's `key` field is the secret. The adapter assumed `{key, secret}`
  and read `created.key.key`, so POST answered 201 with a nearly empty body.
  The use-case tests passed because their fake returned the shape I imagined;
  `api-key-adapter-contract.test.ts` now pins the real one.
- `securityLogRepo` logged `error && error.message` on an `unknown` — a strict
  type error that would itself throw inside the catch.

Verification: 559 files / 5836 tests passing, both packages typecheck clean,
biome clean, standalone smoke covering create/duplicate/empty-name/bad-endpoint
/get/404/rename/delete/delete-again and the four bulk paths. Gateway baseline
unchanged (`/login` 200, `/dashboard` 200, `/v1/models` 401).

Remaining: 156 of 168.

## 2026-10-29 — `usage` (11 handlers) + the strict-mode debt it exposed

What the batch found, in the order it hurt:

- **The period rule had five copies and they disagreed.** `stats` and `chart`
  each carried their own `VALID_PERIODS` with different defaults (`7d` vs
  `30d`), `sparks` a third, `errors` silently folded anything unrecognised into
  `7d`, and `leaderboard` validated nothing — so `?period=banana` answered with
  an empty leaderboard, which a dashboard renders as "no traffic". One value,
  five opinions, two of them invisible. Now `domain/reporting-period.ts` owns
  the accepted set, the per-endpoint default, and the refusal.
- **`packages/db` had 48 latent errors.** `apps/web` runs `strict: false`, so
  none of them had ever surfaced; `apps/api` runs `strict: true` and found them
  on first import. Fixed at the source (`parseJson` overload, `lastUsed ?? 0`,
  `apiKeyKey` nullability, the `connectionsRepo` transaction-callback return),
  not with casts at the boundary.
- **A generated file and the formatter were fighting.** `antislopPrompt.ts` is
  generator output whose payload is one giant string literal, so
  `biome --write` in the pre-commit hook rewrote the prompt itself. My commit
  *shipped the reformatted version*, breaking parity with the `.md` sources in
  the act of committing — `antislop-prompt-parity.test.ts` was red immediately
  after. Fixed by scoping a `biome.json` override to that one path; every other
  file keeps the baseline.
  I had also reverted this same file earlier as "stray formatting". It was not;
  it was the generator's legitimate output and the test was telling me so. Read
  the failing test before deciding a diff is noise.

Verification: 561 files / 5884 tests passing, both packages typecheck clean,
`biome check` clean, `bun run build` green, standalone smoke confirming all 11
`usage` routes delegate (401 without a session, `theme` 200 and `locale` 405
unchanged from baseline). `generateAntislopPrompt.mjs --check` passes after a
commit, not just before one.

Remaining: 146 of 168. Next is not `usage`'s tail: `available-models` and
`api-keys` need `open-sse` behind ports, which is Phase 7's open item.

## 2026-10-29 — `plugins`, `cache-stats`, `dashboard-jobs`, `shutdown` (5 handlers)

Four small endpoints, and one of them cost more than the whole batch.

- **A silent wipe.** The plugins payload check was `typeof !== "object"`, which
  accepts an array. `PUT [1,2,3]` normalised to "every plugin disabled" and
  answered 200. Now `isPluginPayload` requires a plain object, unknown catalogue
  keys are reported as 400 instead of dropped, and `enabled` must be literally
  `true`.
- **The unset-secret trap.** The dev shutdown hook compared the header *after*
  the production check, so with no `SHUTDOWN_SECRET` set, `authorization` and
  `` `Bearer ${undefined}` `` could both be absent and compare equal. Production
  is now checked first, then the secret's existence, then the value.
- **`role: null` is not a permission.** My first version of the dashboard gate
  allowed a session object whose role was `null`, because the old handler did.
  A test I wrote for the obvious case (an apikey session) passed; the one for
  `role: null` failed and made the distinction worth keeping: an unestablished
  role is not "unknown, allow" when the action cannot be undone.
- **The endpoint that killed its own smoke test.** `POST
  /api/version/shutdown` ran `ps aux` and killed every line containing
  "9router" — and on Linux that includes argument text, so it killed the shell
  running the smoke test, `kill -9` and all. Selection is now by executable name
  via `ps -eo pid=,comm=`, in `appProcessSelection.ts`, with the pure functions
  tested. Re-verified live: the shutdown answered 200, the server stopped, and
  the calling shell kept its pid.

Verification: 565 files / 5936 tests passing, both packages typecheck clean,
`biome check` clean on every touched file, baseline 424 (from 443), build green,
standalone smoke covering the plugin typo/array/valid paths, cache counters
reading the real engine (`ttlMs: 10800000`, not zeros), every dashboard-jobs
400/404 branch, and the shutdown hook's 401s plus the dashboard's 200.

Remaining: 140 of 168.

## 2026-10-29 — `pxpipe` (8 handlers)

- **The clamp that let a negative through.** `stats` and `logs` both did
  `Number(x) || 100`, which is fine for a typo but not for `?limit=-5`: `-5 || 100`
  is `-5`, so a negative reached the store as a negative slice. `readListLimit`
  now rejects anything that is not a positive integer and reports `adjusted` so
  the panel can say the value was replaced.
- **409 vs 500 for "not installed".** `start` returned 500 whether auto-install
  was refused or the server genuinely broke. It is a 409 now: the operator has a
  setting to change, and the panel words the two differently.
- **Errors were flattened.** Every handler answered `{error: error.message}` with
  a 500, so a real install failure reached the operator as "Failed to install
  pxpipe". The engine's own `code` is carried through (`PxpipeError`), and live
  verification now returns the engine's actual message: "install finished but
  package is missing - see install.log".
- **`install` and `start` are not on the oRPC router.** That transport accepts an
  API key; a key that can trigger an npm install can change what runs on the host.
  The REST routes keep them behind the password session.

Verification: 566 files / 5955 tests, both packages typecheck clean, biome clean
on every touched file, build green, and a standalone smoke covering status,
`?limit=-5`, `?limit=abc`, health, stop, reload and the failing install path.

Remaining: 132 of 168.

- The custom-model transport whitelist was written into `domain/custom-model.ts`
  but never called: `manage-aliases.add()` forwarded the body straight to the
  store, so an unknown transport landed on the row and then survived every later
  save. `gemini-live-stt` T14 caught it. `add()` now runs `readCustomModel` and
  omits the key entirely when nothing usable arrived — the store reads an absent
  key as "leave the stored value alone", which is what a re-save must do.
- Four tests asserted against route source that no longer holds the rule
  (`model-test-routing`, `models-route-shadow-dedupe`, `sidebar-usage-ownedby`,
  `gemini-live-stt`). Each now exercises the rule where it lives; the shadow
  dedupe test still runs against the real `AI_MODELS` registry, so the collision
  it guards is still a real one.
- `9router-api` package exports gained `./application/models/*` and `./domain/*`
  so tests can reach a use-case without importing the whole app graph.

Verification: 571 files / 6059 tests passing, both packages typecheck clean,
biome clean, `bun run build` exit 0, gateway baseline unchanged
(`/login` 200, `/api/health` 200, `/v1/models` 401, `/api/models/custom` 401).

Remaining: 156 of 168.

## providers batch, part 1 (connection CRUD)

Extracted the two rules the old routes duplicated:

- `normalizeProxyConfig` existed twice with different behaviour. The create copy
  could not distinguish "no proxy fields sent" from "proxy fields sent empty", so
  every create wrote `connectionProxyEnabled: false` over whatever was stored,
  while an update with no proxy fields left it alone. `domain/provider-connection.ts`
  now models three states (absent / set / invalid) and both paths share it.
- `normalizeProxyPoolId` existed twice, differing only on the absent case. Same
  treatment: `absent` / `cleared` / `set`, where cleared removes the key rather
  than storing `null`.

Three branches that copied a node's fields into a connection became one
`nodeFields(node, {includeQuota, includeApiType})`.

Defects this batch caught, all found by existing tests rather than by me:

1. My first `nodeFields` signature took a bare boolean and silently dropped
   `apiType` for OpenAI-compatible nodes — `compatible-provider-connections`
   failed on the missing field. `apiType` is only meaningful for that kind, so it
   is now an explicit option rather than something derived.
2. I then over-corrected and asserted that a custom embedding connection *should*
   carry `quotaEnabled`/`quotaPath`, calling the old behaviour a bug. It is not:
   quota lives on the node and an embedding node has none. The test now pins the
   omission so a future refactor cannot start copying it.
3. The AWS session token rule was dropped entirely. `bedrock-provider-api-secrets`
   caught it. The form cannot read the token back, so every edit sends it blank;
   `""` must mean *keep*, `null` must mean *clear*, absent must mean *leave*. The
   first attempt applied the rule after merging `incoming`, which had already
   overwritten the stored value with the blank — the rule has to read the incoming
   field and decide against the *stored* map.

Nine integration tests failed because the routes now call `getUseCases()`, which
opens the database, and `createDb` refuses under Vitest by design. Each was rewired
to hand the route a real connection use-case over the very stores the test seeds
(`compatible-provider-connections`, `bedrock-provider-api-secrets`,
`embedding-429-key-failover`). One of those mocks had to move ahead of the route
import — a `vi.doMock` after the import leaves the route holding the unmocked
binding.

Verification: 574 files / 6181 tests passing, both packages typecheck clean,
biome clean, `bun run build` exit 0, gateway baseline unchanged
(`/login` 200, `/api/health` 200, `/v1/models` 401, `/api/providers` 401).

Remaining: 154 of 168 handlers (10 of 12 in `providers`).

## providers batch, part 2 (overrides, kilo cache, model probing)

Three rules moved out of handlers, each of which was making a decision nobody
had written down:

- **Header overrides** (`domain/provider-override.ts`). The whitelist was already
  one function, so this was mostly relocation — but the canonical-id lookup is
  now the use-case's job, which closes the case where `/gcli/overrides` and
  `/gemini-cli/overrides` wrote two entries for one provider.
- **The Kilo free-model cache** (`domain/free-model-cache.ts`). The route kept
  one module-level entry and served it past its TTL forever when the upstream
  refused. That is the right instinct — a stale list beats an empty panel — but
  with no ceiling a process up for a month reports a month-old catalogue as if
  nothing were wrong. `MAX_STALE_MS` (24h) puts a floor under it.
- **Model probing** (`domain/model-probe.ts`). Two implicit rules made explicit:
  the first model is probed alone because the probe triggers a token refresh and
  a parallel fan-out races that refresh against itself; cookie providers probe
  serially because their account queue serves one request at a time. Neither was
  stated anywhere, so a future change to the fan-out would have broken tokens or
  timeouts with nothing to explain why.

One trap worth recording: `WEB_COOKIE_PROVIDERS` exists **twice** with the same
name and different types — an object of ids in `shared/constants/providers.ts`,
and a `Set` in `app/api/models/test/probeBudget.ts` re-exported through `ping.ts`.
The route used the `Set`; importing the object and calling `.has()` compiled fine
and failed at runtime. The serial decision belongs to the probe budget's set,
which is what is imported now, under a distinct local name.

Verification: 579 files / 6267 tests passing, both packages typecheck clean,
biome clean, `bun run build` exit 0, gateway baseline unchanged
(`/login` 200, `/api/health` 200, `/v1/models` 401, `/api/providers/*` 401).

Remaining: 151 of 168 handlers (7 of 12 in `providers`).

## providers batch, part 3 (batch test, client listing, suggestions)

Four handlers, three of which were doing two jobs at once.

**Batch testing** (`domain/batch-selection.ts`, `domain/batch-result.ts`). The
grouping was an `if/else` chain in which each branch asked a different question —
`oauth`/`free`/`apikey` look at the auth group, `compatible` at the provider id's
prefix, `all` at nothing — so it read as five filters but was one rule. Two real
defects fell out of writing it down:

- A stored `authType` of `cookie` (also `aws`, `subscription`) fell through every
  branch. No mode selects a group called `cookie`, so a cookie connection **never
  got batch-tested at all** and the panel reported a green run that had skipped
  it. `asAuthGroup` now folds everything that is not `oauth` into `apikey`, which
  matches the probe's own split ("OAuth or not").
- The seven-field result row was written twice, once per branch, and had already
  drifted: the `catch` reported `diagnosis` as a structured object where the
  success path passed a string through. One response carried two shapes of one
  field. `toBatchResult` is now the only place a row is built, and a throw becomes
  an outcome rather than a second code path.

**The client listing** (`domain/client-listing.ts`). The disclosure whitelist ran
*after* the filter chain, so the sorting comparator read `priority` off a
connection that still held its `apiKey`. Sanitising now happens first and
everything downstream reads the sanitised value. While extracting the paging rule:

- `paginate` clamped only the ceiling, so `page: 0` produced `offset: -pageSize`,
  and a negative `slice` index means "from the end" — the **last** page was served
  as if it were the first. Caught by a new test, fixed in the domain.

**Suggested models** (`domain/model-catalogue.ts`). The stale-or-built-in choice
was spelled out three times, once per failure path, which is exactly how a fourth
path would have shipped without the `stale` flag. It is one function now, and the
filter table and its fallback table live in one object so a type cannot exist in
one and 400 in the other.

**`[id]/test`** (`application/providers/check-connection.ts`). Two lines, but the
404-vs-failed-probe line is the panel's behaviour: it offers "test again" on a
failure and refreshes the list on a 404.

Two test-infrastructure notes worth keeping:

- `open-sse/utils/proxyFetch` replaces `globalThis.fetch` as an **import side
  effect**. A spy installed in `beforeEach` is discarded the moment the route
  pulls that module in; it has to be installed after the imports have run.
- Route tests that used to import a handler directly now need the use-case graph,
  and `createDb` refuses a second SQLite handle under Vitest. The pattern is to
  assemble the one use-case over its mocked store and the *real* host functions,
  so the assertion still runs the real decision, then `vi.doMock("@/lib/useCases")`.

Verification: 587 files / 6391 tests passing, both packages typecheck clean, biome
clean, `bun run build` exit 0, gateway baseline unchanged (`/login` 200,
`/api/health` 200, `/v1/models` 401, `/api/providers/*` 401).

Remaining: 147 of 168 handlers (3 of 12 in `providers`).

## providers batch, part 4 (credential validation, interactive web login)

**Credential validation** (`domain/credential-verdict.ts`,
`application/providers/validate-credential.ts`). The handler was an 848-line
`switch` in which each provider ended in its own status test. "401 means a bad
key" is true for most providers and wrong for four of them, and those four are the
entire content of the rule:

| Provider | Reading | Why the default is wrong |
| -------- | ------- | ------------------------ |
| xai | 200 or 403 = valid | answers **400 for a bad key** and 403 for a good key with no credit, so the default calls a bad key valid and a good key invalid |
| xiaomi-tokenplan | anything but 401 = valid | 403 means the key is fine and merely lacks list permission |
| blackbox | 200 or 400 = valid | 400 is the malformed-request answer |
| cloudflare-ai | not 401/403/**404** = valid | 404 means the *account id* is wrong, so reporting the key valid would hide a fixable mistake |
| anthropic | not 401 = valid | 529 is "overloaded"; the key is proven good |

`readerFor` gives each its own reading and everything else `notRefused`, which is
what the generic branch used. One real bug fell out: an anthropic-compatible node
whose base URL was pasted as the full `.../v1/messages` had `/v1/messages`
appended again, producing `/v1/v1/messages`. The old code stripped the last path
segment only.

Two judgement calls now written down rather than implied: a provider whose auth
scheme needs data this endpoint does not carry (PlayHT's two headers, sigv4) is
answered "cannot check" instead of falling through to "not supported"; and a
provider that reaches the end unresolved is **refused** rather than reported
valid — a validation endpoint that says "fine" when it checked nothing is worse
than one that admits it.

**Interactive web login** (`domain/web-login.ts`,
`application/providers/web-login.ts`). The save-on-success step sat in the middle
of the GET handler, and the matching rule across an `if/else` plus a cleanup loop.
The rules, none of them previously stated: match by email so a second account
keeps its own row; adopt the single email-less row; **refuse to guess** between two
email-less rows; delete only same-email duplicates; never delete anything when no
email was revealed, because every such row compares equal.

A test-infrastructure note: route tests that imported a handler directly need the
graph, and `createDb` refuses two SQLite handles under Vitest. Assembling the one
use-case over the *real* host functions keeps the behaviour under test real — that
is how the Nous validation tests still assert the real probe path.

Verification: 591 files / 6498 tests passing, both packages typecheck clean, biome
clean, `bun run build` exit 0, gateway baseline unchanged (`/login` 200,
`/api/health` 200, `/v1/models` 401, `/api/providers/validate` 401,
`/api/providers/web-login` 401).

Remaining: 146 of 168 handlers (1 of 12 in `providers`).

## providers batch, part 5 — the last handler (`[id]/models`)

802 lines, and the reason it was last: it is not one handler. It is 15 provider
adapters behind one URL, and three of the things it does are production bugs
waiting for a refactor that reads carelessly.

**What moved where.** `domain/model-list.ts` holds only what is genuinely shared:
the two URL shapes (`modelsEndpoint`, and `anthropicModelsBaseUrl` which strips a
pasted `/v1/messages` back to the version root) and the two-answer-shapes reader.
The per-provider mess — 34 fixed endpoints, 15 resolvers, GitHub filtering to
`capabilities.type === "chat"` with a non-disabled policy, Codex appending
`-review` variants, Nous prefixing `nous/` so Basic Chat does not read the vendor
namespace as a provider, Gemini CLI's `{ models: { id: entry } }` second shape —
stays in `apps/web/src/lib/providerModelsHost.ts` where the provider modules live.
`application/providers/list-provider-models.ts` holds only the order of the
checks. The route is 49 lines.

**The three bugs that were about to be lost.** All three were in the old code and
all three are easy to "clean up" into a regression:

1. The Anthropic-compatible branch stripped exactly 9 characters (`slice(0, -9)`).
   That happens to equal `"/messages".length`, so it worked and nothing said why.
   It also only stripped once: `/v1/messages/` left a trailing slash and produced
   `/v1//models`.
2. `ollama-local` *and* `ollama` both exist. `ollama` is a fixed endpoint at
   `https://ollama.com/api/tags` (note: `/api/tags`, not `/models`); `ollama-local`
   is a resolver that reads the operator's own host. Collapsing them would send
   every local request to the cloud.
3. The old custom-resolver path raced a 20-second timer against the resolver and
   on timeout answered 504 — but the raced promise kept running and kept its
   socket. Every abandoned request left one open. `AbortSignal.timeout` closes it.

**Status honesty.** The old route answered a provider's 429 as the provider's 429
already; that is preserved and now stated as a rule (`ProviderRefusal` carries the
status, `invalid()` is only for our own 400s). A provider with no list answers 400
*naming it*, not a generic failure.

**Nine existing tests broke, and their fixes taught something.** All nine read the
old route — either as text (`aggregator-providers-batch` asserted the literal
string `dahl: createOpenAIModelsConfig(`) or as a live handler that opened its own
DB (`zed-live-models`, `nous-provider-routes`). The text assertion is now a
behavioural one: find the provider's entry, and assert the URL beneath it. The
handler tests now assemble the use-case over the *real* host functions with only
the store stubbed, which is what keeps the Zed resolver and the Nous filtering
running for real rather than mocked into a tautology.

Verification: 593 files / 6544 tests passing (74 skipped), both packages typecheck
clean, biome clean on every changed file, `bun run build` exit 0, gateway baseline
unchanged (`/login` 200, `/api/health` 200, `/v1/models` 401,
`/api/providers/xyz/models` 401).

**`providers` is complete: 12 of 12.** Remaining: 145 of 168 handlers.

## settings — the row's general read and write

184 lines, and the reason it took a rule file: seven separate decisions were
interleaved with the read-write, and four of them are security-shaped.

**The one real bug the extraction caught.** The old handler stripped the
admin-only field from the body for *every* caller:

```
if (adminOnlyAttempt) {
  if (session?.role === "apikey") return 403
  delete body[adminOnlyAttempt]        // ← also ran for administrators
}
```

An administrator editing the theme through the settings form had the field
deleted before the write, so the write reported success and changed nothing. Three
of my own use-case tests failed on exactly this the first time — which is the
point of testing the rule apart from the handler.

**What the rules say, now that they say anything at all.**

- `PROTECTED_SETTING_KEYS` is a mass-assignment guard, not a preference: `password`
  is written only through the `newPassword` flow where the old one is verified and
  the new one hashed, and `mitmSudoEncrypted` only by the code that encrypts it.
  The strip happens *first*, so neither can reach the before-image either.
- `theme` is refused with 403 rather than dropped for an API-key session. Dropping
  it would let the caller believe the site-wide theme changed.
- A form field arriving as `undefined` is not an attempt. Every ordinary save sends
  the whole form.
- The password rule answers what the change still *needs* (`verify`), not whether
  it is allowed — hash comparison is async and only the caller has the hash. My
  first draft had a synchronous cache standing in for that comparison, which would
  have answered `false` forever; the type system did not catch it, a test did.
- A blank `oidcClientSecret` means "leave it alone": the form cannot read the
  secret back, so blank is its normal state.
- The four side effects (proxy env, combo rotation, proxy health, auto-ping) are
  named as *owed by certain fields*, so `sideEffectsOf` can be tested without a
  process. All four exist because leaving one out was a real bug.

Verification: 595 files / 6600 tests passing (74 skipped), both packages typecheck
clean, biome clean, `bun run build` exit 0, gateway baseline unchanged (`/login`
200, `/api/health` 200, `/api/settings` 401, `PATCH /api/settings` 401,
`/v1/models` 401).

Remaining in `settings`: 8 of 9. Remaining overall: 137 of 174.

## settings, part 2 — the audit trail

Three handlers (`history`, `rollback`, `require-login`) plus the shared session
lookup, and the same defect pattern as the row itself: an authorisation check
written three times, once per handler, in three slightly different shapes.

`requireAdmin` in `history` answered `false` for both "no session" and "API key",
then answered 401 for both. `rollback` checked the same thing inline and answered
**403** — for a caller it had already decided was unauthenticated. That is the
distinction the theme route and the settings row both keep correct, lost here.
The rule is now one function, `mayRevertSettings`, with the difference stated:
history is readable by any signed-in session (it holds no secret), reverting is
password-sign-in only.

Two smaller things the extraction made explicit:

- A revert that restores nothing is now refused. It happened when every key in a
  snapshot was a secret, or when the caller asked only for keys the snapshot does
  not carry — and the old code would have written an empty patch and answered 200.
- `revertPatchOf` will not invent a key the snapshot lacks. Writing `undefined`
  would have *deleted* the setting instead of leaving it alone.

**A boundary lesson.** `getSettingsSnapshot` returns `unknown` per column — it
reads a `SELECT` with no schema — and `listSettingsHistory` returns `keys[]` while
`getSettingsSnapshot` returns `snapshot`. My first port forced one shape onto both
and the compiler refused. The right answer was not to bend the use-case: the two
queries genuinely answer different things (a list view must not ship every
before-image), and the loose `unknown` columns are normalised in the host adapter,
where the untyped SQL row stops.

`require-login` keeps answering 200 with `requireLogin: true` when the row cannot
be read, and the domain rule states why: this is what the login screen asks for,
and a 500 there locks the operator out of the screen they would fix it on.

Verification: 596 files / 6633 tests passing (74 skipped), both packages typecheck
clean, biome clean on every changed file, `bun run build` exit 0, gateway baseline
unchanged (`/login` 200, `/api/health` 200, `/api/settings` 401,
`/api/settings/require-login` 200, `/api/settings/history` 401,
`POST /api/settings/rollback` 401, `/v1/models` 401).

Remaining in `settings`: 4 of 9 (`auto-backup`, `database` ×3, `proxy-test`).
Remaining overall: 133 of 174.

## settings, part 3 — the install's own storage

Four handlers (`database`, `database/jobs`, `database/jobs/[jobId]`, `proxy-test`).
The interesting part is not the export: it is that the same four-way credential
check was written out three times, and each copy explained a different one of the
four reasons.

The rule is now `domain/database-access.ts`, and the reasons are written down where
the rule is: a CLI token (the operator already has the database), a password (the
dashboard's way in), a poll token, and the summary exemption. The poll token is the
one that earns its own paragraph — the import replaces the settings row holding the
password hash, so a client polling with its password is compared against the row it
just overwrote. The old code answered "Invalid password" over a restore that had
committed. `verifyPollToken` is checked first for exactly that reason.

Three defects the extraction fixed:

- The synchronous import took its password **in the body**, and the body *is* the
  database. `{ password, ...payload }` was correct, but one refactor away from
  writing a `password` row into every import. `bodySplit` is now the only place the
  two are separated.
- An oversized import was answered `413` by a route that had not yet decided the
  caller was allowed to import at all. The size check now runs first and answers
  `PAYLOAD_TOO_LARGE` (a new `AppError` code, mapped to 413 in both boundaries),
  which keeps "too big" and "not allowed" from being the same answer.
- `exportSectionsOf(",,,")` used to export *everything* while looking like it had
  asked for nothing. It still exports everything, and says so: a list of blank
  sections means no filter, because an empty filter would export an empty backup
  and report success.

**A verification note.** My first smoke test asserted `?summary=true` answers 200
without a credential, and it answered 401. That was not a regression: `dashboardGuard`
lists `/api/settings/database` in `ALWAYS_PROTECTED`, so the guard refuses before any
handler runs — the summary exemption only reaches a caller that already passed the
guard, i.e. a CLI token. The guard is untouched (`git diff` empty), so the behaviour
is the pre-migration behaviour. Worth recording because the assumption was mine, not
the code's.

Verification: 598 files / 6685 tests passing (74 skipped), both packages typecheck
clean, biome clean, `bun run build` exit 0, gateway baseline unchanged (`/login` 200,
`/api/health` 200, `/v1/models` 401, `/api/settings/database` 401,
`/api/settings/database/jobs/x` 401, `/api/settings/proxy-test` 401).

Remaining in `settings`: 1 of 9 (`auto-backup`). Remaining overall: 129 of 174.

## settings, complete — the scheduled backup

The last of the nine. Three operations on one screen, and the rules they share were
spread across a GET, a PATCH and a POST that each knew a different part of the truth.

What is now stated rather than implied:

- **Secrets are write-only.** `publicConfig` never returned a token — that rule was
  correct and undocumented. It is now a domain function with the reason attached: this
  endpoint is reachable from a browser, and an echoed token lands in page memory, the
  devtools log, and every screenshot the operator takes while asking for help.
- **An empty secret means "keep the stored one."** The masked field sends nothing when
  untouched, so without this rule editing the interval erases a token. The old PATCH
  happened to be right; `backupPatchOf` now says why.
- **An interval cannot be zero.** `clampIntervalHours` floors at one hour. Zero asks
  the scheduler to run continuously; a negative one computes a due time in the past
  and does the same. The old clamp had the floor but no ceiling; a year is now the cap,
  because anything larger is a typo that removes the backup from the calendar.
- **A chat id with no digits is refused, not stored empty.** An empty chat id fails at
  *send* time, hours later, with nothing in the screen to explain it — the worst kind
  of failure to leave silent.
- **The countdown reports an overdue backup as overdue.** The old code already did
  this, and the comment explaining it was the only place the reasoning survived. It is
  now `nextBackupAt`, with the counterfactual named: pinning to "now" made the
  countdown sit at 00:00:00 and read as stuck rather than overdue.

The GET has a side effect on purpose — it re-arms a scheduler that a restart killed.
That is written into the use-case rather than left as a comment, along with the detail
that makes it work: the scheduler state is read *again* after arming, so the countdown
answers with the timer that is now running and not the one that was not.

A failed test send answers `ok: false` and not a 5xx. The request succeeded; the answer
is "the backup could not be delivered, here is why", and the screen shows the provider's
message. Throwing would route it through the generic error path and lose the only
useful part of the response.

Verification: 600 files / 6736 tests passing (74 skipped), both packages typecheck
clean, biome clean, `bun run build` exit 0, gateway baseline unchanged (`/login` 200,
`/api/health` 200, `/v1/models` 401, `/api/settings` 401, `/api/settings/auto-backup`
401 for GET, PATCH and POST).

**`settings` is done — 9 of 9.** Remaining overall: 128 of 174.

## proxy-pools, part 1 — CRUD and the egress test

Four handlers (`route`, `[id]`, `bulk`, `[id]/test`). Two rules had three copies each:
what a proxy URL must look like, and whether a pool may be deleted. Both are now in
`domain/proxy-pool.ts`.

The rule worth naming is the deletion one. A connection stores its `proxyPoolId` inside
an opaque JSON column, so deleting a bound pool leaves the connection pointing at
nothing and the failure surfaces later as a dial error with no trail back to the
deletion. The single delete refused it; the bulk delete refused it too, but each had its
own copy of the count and its own wording. There is now one `boundConnectionCount` and
two refusals that differ only in message — "currently in use" versus "some pools are
currently in use" — because the screen needs to name what is in the way.

Three defects the extraction fixed:

- **The bulk delete could partially delete.** If one selected pool was bound, it answered
  409 — correct — but a *second* request with the bound pool removed deleted the rest one
  at a time. Nothing here changed that, but `deletionOutcome` now reports the ids the
  store did not remove, so a partial delete can no longer be reported as complete.
- **A socks URL was accepted at save time.** The runtime cannot dial it, the no-leak
  policy then blocks the direct fallback, and the dashboard shows a healthy pool that
  answers every request with `UnsupportedProxyProtocol`. Refused at save now, where the
  operator can still fix it.
- **A test moved `isActive` and said so nowhere.** A failing test now deactivates the
  pool so the router stops retrying a known-broken path, and a passing test re-activates
  one that was switched off. Both directions are stated in the domain, because the next
  reader will otherwise "fix" it as a bug.

**Two structural corrections along the way.**

`ProxyPoolStore` already existed — a one-method port (`exists`) that the provider
create-path uses. I first added a second port with the same name in the same
dependencies interface. The compiler refused, and rightly: the row type is shared by two
readers, so the port was extended rather than duplicated.

Then a `git checkout --` of the factory, meant to undo a bad regex, reverted 240 lines
instead of 16 — the regex had eaten from my `proxyPools` block to the end of the object.
Nothing was lost (the work was committed), but the lesson is worth recording: a regex
that matches "a block" in a 636-line file is not a safe edit, and `patch` with a unique
anchor is. One knock-on broke: `dashboardJobHandlers.ts` called the `[id]/test` handler
in-process with `params: { id }`, and the delegation now takes `params: Promise<{id}>`.

Also worth noting: `proxyPoolHost.ts` initially imported `server-only`, which broke four
test files that import `providerConnectionHost` (now re-exporting the pool host). The
neighbouring hosts do not carry that import, and the fix was to match them rather than
to teach the test runner about a Next-specific package.

Verification: 602 files / 6799 tests passing (74 skipped), both packages typecheck clean,
biome clean, `bun run build` exit 0, gateway baseline unchanged (`/login` 200,
`/api/health` 200, `/v1/models` 401, `/api/proxy-pools` 401 with and without
`includeUsage`, `/api/proxy-pools/xyz` 401, `POST /api/proxy-pools` 401,
`DELETE /api/proxy-pools/bulk` 401).

Remaining in `proxy-pools`: none — the batch is closed.
Remaining overall: 120 of 174.

### Relay deploy — four providers, one use-case

`application/proxy-pools/deploy-relay.ts` orders the work once: start, wait, register.
What differs is data, not control flow, so the differences moved into
`domain/relay-deploy.ts`:

| Provider   | Token field  | Also required | URL comes from            |
| ---------- | ------------ | ------------- | ------------------------- |
| vercel     | vercelToken  | —             | poll `readyState` → `url` |
| cloudflare | apiToken     | accountId     | derived from subdomain    |
| deno       | denoToken    | orgDomain     | derived from org domain   |
| netlify    | netlifyToken | —             | site `ssl_url` + path     |

Three rules the original code stated only in its branches:

- **The token field is provider-specific.** A shared `token` field would have accepted a
  Vercel token for a Netlify deploy and failed at the provider's edge with "unauthorized"
  — a blank form reported as an auth error.
- **Netlify's relay lives at a path.** The site root serves a placeholder page; the relay
  is `/.netlify/functions/relay`. A pool pointed at the root fails every request while the
  deployment itself looks healthy.
- **Netlify's site name becomes a subdomain.** `Netlify-Relay!!` has to be hydrated to
  `netlify-relay` before the provider sees it, and a 422 "name taken" is a 409 the screen
  can act on.

A deployment that reports a terminal failure is refused with that state, not with
"timed out": waiting the full two minutes to then report the wrong cause is worse than no
report. Deno creates an app and deploys into it, so a failed deploy now discards the app
through the port's `discard` hook rather than leaving the name occupied.

The route-level Netlify test was rewritten over the use-case and the real host calls,
because the route now only delegates — `createDb` refuses to open inside Vitest, so a test
that imports the route tests the delegation, not the behaviour.

Verification: 604 files / 6836 tests passing, both packages typecheck clean,
`bun run build` exit 0, gateway served (health 200, `/login` 200, `/api/proxy-pools` 401,
all four deploy routes 401 unauthenticated — the same refusal as before the port).

### Bulk proxy import — the job outlives the browser

`domain/proxy-import.ts` holds the row rules; `application/proxy-pools/import-proxy-pools.ts`
owns start/poll/cancel. Two mistakes were worth stating:

- **A bare `host:port` is refused.** The pool table would store it happily and the first
  request routed through it would fail — the worst place to discover a typo.
- **An empty list is not an invalid one.** `Nothing to import` and `Invalid entries: …` are
  different mistakes, and telling them apart is what tells the operator which field to fix.

The poll answers `no-store`, and an unknown id is 404 rather than an empty page: the
dashboard polls while a job runs, so "gone" must not read as "nothing to report yet". The
recent list is paged to 10 — the screen reattaches to a page, not a history.

The port shape was corrected against the real store twice: `create` answers a summary
(`jobId`/`status`/`total`), and a job row carries `counts`, not flat counters. Guessing the
shape cost a round trip each time; reading `proxyImportJobs.ts` first would not have.

Verification: 606 files / 6860 tests passing, both packages typecheck clean,
`bun run build` exit 0, gateway served (`/login` 200, `/api/health` 200), and all three
verbs of `/api/proxy-pools/import-jobs` answer 401 unauthenticated.

### A flaky file was a timeout, not a wrong answer

One background run reported six failures across four files — three of them in
`suggested-models-sync.test.ts` — while the same files passed twice standalone and the same
full suite passed three times. The reported duration was the tell: 4008ms, 4101ms against
Vitest's 5000ms default. The message read `expected 'https://…' to be 'https://…/.netlify/…'`,
which looks like a wrong answer but was the per-request `withTimeout` ceiling returning the
built-in catalogue before the stubbed fetch settled.

No production code changed. Each case in that file binds its answer to a stubbed fetch or a
stubbed store, so a slow run can only be the machine's — the file now sets its own 30s
timeout rather than sitting one second from the global default. A test that reports a wrong
answer when it actually timed out sends the next reader into the wrong file, which is worse
than the flake itself.

Verified afterwards: 606 files / 6860 tests passing under the full parallel suite.

### Tunnel — seven routes, three shapes

`domain/tunnel.ts` holds the rules; `application/tunnel/manage-tunnel.ts` owns the order.
The seven routes were never seven behaviours:

- **`status`** — probe cache (`STATUS_CACHE_TTL_MS`), with download progress deliberately
  uncached because it is the number the operator watches move. A clock that moved backwards
  counts as stale: reusing an entry timestamped in the future freezes the panel, and the
  cause is nowhere near the symptom.
- **four toggles** — one function, because they differ in two ways only: which switch, and
  whether the answer waits for DNS. Only a Cloudflare *enable* waits (`DNS_WARMUP_DELAY_MS`);
  an enable that is slow because the watchdog failed to start would read as "the tunnel did
  not come up", so monitoring is re-armed fire-and-forget.
- **`tailscale-check`** — three probes in parallel, none of them run when Tailscale is not
  installed: probing a daemon that cannot exist costs a timeout per poll and reports "not
  running" for something that was never there. The two daemons are reported separately *and*
  as a union, so a machine where the bundled one failed but the system one lives does not
  read as a plain success.
- **`tailscale-install`** — the gate (password needed? which password?) runs **before** the
  stream opens, so a refusal is a 400 the form can show rather than an event nobody styled.
  The stream itself stays in the route: a use-case cannot own a `ReadableStream` without
  owning a framework. A typed password beats the cached one — the operator typed it because
  the cached one was wrong — and `sudo`'s own "Sorry, try again." is translated to
  "Wrong sudo password" rather than sent to a screen that cannot act on it.

Smoke against the standalone build: `/api/tunnel/status` answered the real probe payload
(both services disabled, download 0%) and `/api/tunnel/tailscale-check` found the machine's
actual Tailscale — `installed: true`, both daemons running. The guard still refuses
unauthenticated callers, and refuses the six machine-touching routes from non-localhost with
403 (they are on `LOCAL_ONLY_PATHS`), which is the behaviour the routes had before the port.

Fixed on the way: `apps/api/package.json` had no `./application/tunnel/*` subpath export, so
`apps/web` could not import the use-case at all. `tunnelStatusCache()` also needed a home —
it now hangs off `globalThis` so a hot reload reuses it instead of re-probing per request.

Verification: 608 files / 6897 tests passing, both packages typecheck clean,
`bun run build` exit 0, gateway served (`/login` 200, `/api/health` 200).

## 2026-10-29 — `oauth` batch, 12 of 20

The batch is one pattern in three shapes: **read a credential the operator already has,
prove it works, then write one row.** Porting it found three defects that the old routes
had been carrying.

**A port the host never supplied reached production as a 500.** `cursorImport` was declared
on the graph, called by the route, and wired in neither place — every unit test on either
side passed because each one stubbed the other. It surfaced in the smoke test, not the
suite. The guard is `required()`, so `required()` now has its own test
(`tests/unit/use-case-graph-ports.test.ts`) asserting it names the missing port instead of
returning `undefined`. The same class of bug is why `importToken`/`importApiKey` resolve
their verifier from a host table *before* the graph is built: a missing entry is a refusal
at assembly, not a crash per request.

**`apps/web` compiles with `strict: false`, which silently disables union narrowing.** A
correct `{ ok: true } | { ok: false, error }` union cannot be read with `if (!result.ok)`
there — TypeScript keeps the union and rejects `result.error`. Rather than cast in every
route, the use-case exposes `ImportAnswer`, a flat shape with optional fields. `apps/api`
keeps the union internally; only the boundary flattens.

**Cursor's auto-import was already a three-strategy ladder, and the tests knew it.** The
first version of the port read the database one way and answered "not found" for the rest,
which failed ten existing tests that asserted the paste-box fallback and the Linux
"config exists but the IDE is not installed" check. The ladder is now explicit: bundled
`better-sqlite3` → `sqlite3` binary → `windowsManual`, with each failure silent and the
next strategy tried. Restored, not simplified.

Other decisions worth keeping:

- **Codex import does not call OpenAI.** Its access token is a JWT the operator created in
  ChatGPT's settings, and the claims inside it are what the row needs. It is stored as
  `authType: "access_token"`, not `oauth` — there is no refresh token, and recording it as
  OAuth would make the refresh path try to renew what it cannot.
- **A key that could not be checked is `untested`, not refused.** The network may be the
  problem, not the key. Kiro is the exception: its validation failure is terminal because
  the upstream body names an endpoint and must not be reflected back.
- **MiMo re-imports over its own row.** It is the one provider importable from a session
  cookie with no key, so a second import of the same account updates rather than
  duplicates — otherwise rotation spends the same account twice.
- **Provider names are not slugs.** The not-found message read "log in to xiaomi-mimo first"
  until `providerNameOf` mapped slugs to display names.

Verification: 613 files / 6991 tests passing, both packages typecheck clean, `bun run build`
exit 0. Smoke against the standalone build: all four `auto-import` routes answer 200 with
real probe data, all four `import` routes answer 400 (not 500) on an empty body with the
field they want named, `api-key` refuses both an empty key and a wrong prefix, `bulk-import`
refuses an empty batch, and a synthetic Codex JWT imported successfully and wrote a real row
(removed afterwards).

### oauth dispatcher — `[provider]/[action]` ported

The last three actions in the OAuth dispatcher now run as a use-case instead of three
`if/else if` chains inside the route:

- **`domain/oauth-dispatch.ts`** — one table answers *which provider runs which action*:
  `SESSION_PROVIDERS` (codex, xai, trae, windsurf, zed, xiaomi-mimo), `IDE_PROVIDERS`
  (trae, windsurf), `MANUAL_CODE_PROVIDER` (xai). `sessionSurvivesPoll()` carries the one
  exception that matters: a finished MiMo session must outlive the poll because `/exchange`
  has not run yet. Clearing it there would break every MiMo login — a regression the suite
  now pins from both sides (finished → survives, failed → cleared).
- **`application/oauth/dispatch-actions.ts`** — `pollSessionStatus`, `stopProviderProxy`,
  `readIdeStatus`. A poll with no `state` is a 400, not an "unknown" answer: the two mean
  different things to a waiting screen. `stop-proxy` succeeds when nothing is running,
  because the dashboard calls it on cancel and unmount and an error there would surface
  over a login that already worked.
- **`apps/web/src/lib/oauthSessionHost.ts`** — a `SESSIONS` table with `read`/`clear`/
  `stopProxy`/`detectIde` per provider replaces six `if (provider === ...)` branches.

`DispatchAnswer` is a flat interface rather than a discriminated union on purpose: `apps/web`
compiles with `strict: false`, where TypeScript refuses to narrow a union, so the union form
does not compile in the route that consumes it.

Tests: 21 new cases in `tests/unit/use-case-oauth-dispatch.test.ts`, plus the six MiMo
lifecycle cases in `xiaomi-mimo-oauth-session.test.ts` rewired onto the use-case with every
original assertion intact (they guard a real past regression, so they were re-pointed, not
weakened). Smoke against the standalone build: `poll-status` → `{"status":"unknown"}`,
`ide-status` on trae → 200 `{installed:false,path:null}`, on kiro → 400 naming trae/windsurf.

Verification: 614 files / 7012 tests passing, both packages typecheck clean, `bun run build`
exit 0.

### oauth batch closed — 20 of 20 routes ported

The five remaining OAuth routes now delegate. Each one gained a domain file that names the
rule the route used to spell inline, and a use-case that owns the order of operations.

- **`gitlab/pat`** — `domain/gitlab-pat.ts` + `application/oauth/gitlab-pat.ts`. Verify, then
  write: the token is stored only after GitLab confirms it, so a connection row never exists
  in a state that silently cannot authenticate. The three failure kinds are kept apart —
  401 (refused token), 400 (base URL the SSRF guard blocks), 500 (anything else) — because
  collapsing them tells the operator to try a new token when the host was the problem.
- **`iflow/cookie`** — `domain/iflow-cookie.ts` + `application/oauth/iflow-cookie.ts`. Two
  calls in a fixed order (read the key's name, then refresh it), only `BXAuth` is stored out
  of the pasted jar, and the key is masked in the answer. The platform's own status passes
  through, so an expired session reads as 403 rather than as our bug.
- **`xiaomi-mimo/login/start`** — `domain/mimo-login.ts` + `application/oauth/mimo-login.ts`.
  Region decides the cluster *and* whether an egress probe runs at all; CN never probes, so
  the common login never waits on a socket scan. `readMimoRegion` is now also used by the
  route that begins the session, so the region there and the region the use-case acts on
  cannot drift apart.
- **`xiaomi-mimo/login/status`** — `mimoLoginStatus()` replaces the inline condition chain.
  `expired` outranks everything (a session the browser lost cannot be reported pending, or
  the modal spins forever), and `done` requires an identity so nothing is persisted empty.
- **`kiro/social-authorize` + `social-exchange`** — `domain/kiro-social.ts` +
  `application/oauth/kiro-social.ts`. Authorize and exchange have separate dep interfaces on
  purpose; the first draft had one interface, which forced each route to supply a function it
  never called (`throw new Error("not used")`) — a trap for whoever wires the next provider.

Fixed while porting: `tests/unit/gitlab-pat-ssrf-guard.test.ts` could not resolve its own
route import (`@/...route.js` has no matching `route.ts` under the alias) and stubbed
`global.fetch`, which the route no longer used for remote callers. The three SSRF cases are
unchanged in intent and now spy on the fetch the route actually injects. Also: the route
resolves `globalThis.fetch` at call time, so a test that replaces it is honoured.

Verification: 617 files / 7077 tests passing, both packages typecheck clean, `bun run build`
exit 0, and the standalone build answered — gitlab without token 400, gitlab loopback base
400 `URL not allowed` (guard refuses before fetching), iflow without cookie 400, kiro
social-authorize with a bad provider 400 and with `google` a real `kiro://` PKCE URL.

## cli-tools batch complete — all 15 per-tool settings routes

Every `api/cli-tools/*-settings` route now delegates to `getUseCases().cliTools` on top of
`domain/cli-tool-settings.ts`, or to a domain module of its own when its file format differs:
`omp-models-yml.ts` (YAML), `jcode-config.ts` (nested TOML table), `hermes-yaml.ts` (YAML with
profiles), `grok-build-config.ts` (TOML with markers).

The four ports that needed more than the shared `ToolConfigPort` are the interesting ones:

- **`omp`** — the route removed its provider block with `\s*9router:[\s\S]*?(?=\n\s*\w+:|$)`. Two
  regex rewrites both failed the idempotence test, in opposite directions: the first matched
  nothing when the block was indented (second save appended a duplicate, file no longer valid
  YAML), the second swallowed the sibling provider below it. It is now a loop over lines — our
  block is the `9router:` line plus every following line blank or indented deeper — and that
  version is what the test was written to force.
- **`deepseek-tui`** — the only tool that owns its whole file. A save replaces it; a reset writes
  `provider = "deepseek"` back rather than deleting it, because an empty file is a tool that does
  not start. Expressed as a new optional `resetTo` port. The first cut dropped the existing
  "nothing to reset" answer for tools *without* a default and two older tests caught it.
- **`jcode`** — the entry is spliced as text, not round-tripped through `confbox`: a round-trip
  rewrites comments and ordering on every save. Safe only because the entry is flat, so the test
  pins that a neighbouring table survives byte-identical.
- **`hermes`** — `hermesYaml.ts` was already pure (no imports, 27 tests) and only moved to
  `domain/`. Its route keeps `profiles`/`selections`/`audio`/`applyToAll` orchestration: pressing
  those into the shared port would make every other tool's port carry four concepts it ignores.

Two pre-existing strict-mode failures were found because moving a file into `apps/api` makes
`tsc -p apps/api` look at it: `grok-build-config.ts` had untyped parameters, and `hermes-yaml.ts`
declared `parseKeyValues` as returning `Record<string, string>` when it returns a getter. Both
were type-only fixes; the 27 hermes tests were unchanged and still pass.

Verification: 624 files / 7164 tests passing (13 files / 74 tests skipped), `tsc -p apps/api` and
`tsc -p apps/web` both 0 errors, `bun run build` exit 0, and the standalone build answers — health
200, and omp/jcode/deepseek-tui/hermes all 401 behind auth (the gate runs before the handler, so
401 rather than a 400 tells us routing and the guard are wired, not that the port is unreachable).

## cli-tools non-settings routes

The remaining `api/cli-tools/` handlers were not settings screens; three of them still had
untested decision logic, and two are pure plumbing that should stay where they are.

| Route | Outcome |
| ----- | ------- |
| `codex-profiles` | `domain/codex-profiles.ts` — name/model validation, filename derivation |
| `cowork-mcp-registry` | `domain/cowork-mcp-registry.ts` — which registry entries 3p Cowork can reach |
| `cowork-mcp-tools` | `domain/cowork-mcp-probe.ts` — reading a `tools/list` reply |
| `all-statuses` | left — a fan-out over 19 `GET` exports, no rules of its own |
| `hermes-profiles` | left — one call into the existing profile host |
| `antigravity-mitm` | not ported yet — process manager, needs its own reading |

What the three extractions pinned, all of it previously inline and unstated:

- A codex profile *name* is a path guard, not tidying: `../x` never matched `[a-zA-Z0-9_-]`, but
  nothing recorded why it must not. A model is a TOML-escape guard for the same reason — a `"` or
  newline would end the string.
- Cowork's registry filter is a feature, not a nicety: an entry brokered through claude.ai cannot
  be reached from 3p at all, so offering one yields a plugin that fails on first use and reads to
  the operator as "9Router is broken".
- A 401 from an MCP probe means "wants OAuth", not "broken", and an SSE reply must be matched by
  JSON-RPC id — the first `data:` line carrying a `result` is often a notification.

Naming collision worth remembering: `tests/unit/codex-profiles.test.ts` already existed for the
dashboard's `deriveProfileNameFromModel` helper. Rather than overwrite it, the new file is
`codex-profile-files.test.ts`. Check for an existing test file before naming a new one after the
route it covers.

Verification: 628 files / 7214 tests passing (13 files / 74 skipped), both packages `tsc` clean,
`biome check` clean on all nine touched files, `bun run build` exit 0.

## devin-settings: the dashboard now agrees with the executor

`devin-settings` was the last `*-settings` route not on a domain module, and it turned out to be
the one that matters most for a different reason: it duplicated the executor's binary lookup, and
the two had **already drifted**. The executor probes `~/.local/share/devin/bin` (the official
installer's destination); the screen did not. A Devin installed there reported "not installed" in
the dashboard while the gateway spawned it fine, and neither file mentioned the other.

The list now lives in `domain/devin-binary.ts`. `open-sse/` cannot import from `apps/api` — it is a
standalone engine — so the executor keeps a copy, but the copy names the domain file, and
`tests/unit/devin-binary.test.ts` **reads the executor's source** and asserts each location is
still present. A comment saying "keep in step" decays; a test that parses the other file does not.

`devin-settings` also has no POST and no DELETE, and that is correct: Devin owns its auth
(`devin auth login`), so there is nothing for this screen to write and no `ToolConfigPort` to give
it. Forcing it into the shared port would have invented a write path with no file behind it.

Lesson worth carrying: when a route duplicates a list that another package also holds, the
duplication is the finding. Extract the list, then assert parity against the copy that cannot
import it — reading the other file in a test is legitimate when the module graph forbids sharing.

Final state for `cli-tools`: 22 of 25 routes on domain modules or use-cases, 3 left by decision
(`all-statuses` fan-out, `hermes-profiles` host call, `antigravity-mitm` process manager).
Verification: 629 files / 7223 tests passing (13 files / 74 skipped), both packages `tsc` clean,
`biome check` clean, `bun run build` exit 0.

## antigravity-mitm: the ordering, not the process

`antigravity-mitm` closes `cli-tools`. It could not go where the other routes went: it spawns a
privileged proxy, installs a root CA and rewrites the hosts file, so `apps/web/src/mitm/manager.ts`
stays exactly where it is. But almost everything the route *decided* was not a host concern:

**Password order.** The route resolved `request → session cache → encrypted store`. That order is
load-bearing and was undocumented. Preferring the cache over the request means a password the
operator just corrected is rejected forever; reading the encrypted store before the cache hits disk
on every click for no gain. `resolveMitmPassword` now states it once and the test names both
failure modes.

**Windows cannot escalate mid-request.** This was a real defect, not tidying. `mitmHasPrivilege`
returned true as soon as a password was present, on every platform — but on Windows there is no
sudo, so a typed password bought nothing and the operator got a 403 *after* being prompted. Now
privilege refuses any password on Windows and `mitmNeedsPasswordPrompt` never asks there; the
message says to restart elevated, which is the only thing that works.

**403 for a malformed body.** `PATCH` checked the body and the privilege, and the body check could
be reached second. A caller with no privilege sending `{action: "enable"}` with no `tool` was told
their body was fine. Validation now precedes privilege, so 400 means 400 whoever is asking.

**`trust-cert` is machine-wide.** It arrives through the same `PATCH` as the per-tool DNS toggles,
so `isPerToolDnsAction` exists to keep them apart — otherwise a hosts entry appears for a tool
literally named `trust-cert`.

One TypeScript finding worth keeping: `apps/web` compiles with `strict: false`, and under that
setting a discriminated union does **not** narrow through `if (!answer.ok)`. Every `.error` access
on the failure branch became a type error. Rather than sprinkle casts, the domain exports
`isMitmFailure` as a type predicate — it reads as intent and works under either tsconfig.

Final state: `cli-tools` 25/25 — 22 on domain modules, 3 documented as correctly host-side.
Verification: 630 files / 7248 tests passing (74 skipped), both packages `tsc` clean,
`biome check` clean, `bun run build` exit 0, pre-commit hooks passed.

## usage batch (1/3): observability, key report, derived figures

Three commits, and the pattern was the same each time: the handler was doing two jobs — querying
and deciding — and only the deciding part needed to leave.

**`7d5e9838b` — observability + key report.** `/api/usage/request-details` let `?page=abc` reach
the store as a `NaN` offset, which renders as "no requests" instead of an error. `/api/usage/api-keys`
had three separate guesses about its own numbers: which token count is true (the quota column, or
the pruned log), when a quota window rolls over (it reported idle keys as due in the past), and
whether orphaned usage belongs in a filtered view (it does not — unseen keys are not "deleted", and
labelling them so invites deleting them).

**`851f604a2` — one verdict on success.** `errors` and `leaderboard` disagreed about a status
stored as `"OK"`: case-insensitive string compare in one, case-sensitive SQL `IN (...)` in the
other. Same row, same page, two different answers. One `isSuccessStatus` and `LOWER(status)` in
the query fixed it.

A process note worth keeping: I wrote a clamp for `pageSize` above 100 for symmetry with
`?limit=`, and the existing contract test — which asserted 400 — caught it. The two clamps have
different callers: `?limit=` is a free-form scrape, `pageSize` comes from the table's own pager,
so an impossible value there is a bug in the pager and must not be silently moved. I had the
abstraction half right and the test knew better.

`isPeriodRefused` is now the third such predicate (`isMitmFailure`, `isPageFailure`). The reason
keeps recurring: `apps/web` compiles with `strict: false`, so discriminated unions do not narrow
through `if (!x.ok)`. Better one named predicate than a cast per call site — but if `strict` is
ever turned on for `apps/web`, these can all go back to plain `if`s.

Verification: 633 files / 7312 tests, both packages `tsc` clean, `biome check` clean, build exit 0.

Next: `usage/[connectionId]` (243 lines, credential refresh + quota fetch), then `available-models`,
`providers`, `stream`, `antigravity-tier`.

## usage batch (2/3): antigravity tier, connection quota

**`69ce8f8b6` — Antigravity tier.** Transport (token read, two upstream probes, five-minute
cache) stayed; the verdict moved to `domain/antigravity-tier.ts`. The extraction caught a defect
in my own first draft: rewriting the model-id patterns while lifting them made them *narrower*
than the original, so `claude-opus-5-5` and `sonnet5.5` stopped matching. Silent in the worst way
— the models stop being marked, reappear in the picker looking available, and 404 only when
selected. Patterns are now the original set widened, and the test names all eight spellings.

Also made explicit: the catalogue outranks the tier id (tier ids are undocumented and have changed
before), and an *empty* catalogue is "no answer" rather than "nothing available" — reporting a
probing failure as a free-tier verdict is a wrong answer confidently given.

**`9abb48a33` — connection eligibility and token updates.** 243 lines of five nested conditions
became three named rules: two `authType` spellings, custom-quota eligibility coming through the
node rather than the connection, and an expired-auth message that arrives as a 200. `authExpiryVerdict`
retries only with a refresh token in hand and tells an API-key connection to reconnect instead of
letting it spin.

Two merge rules carry consequences and are now stated where they live: `expiresIn` beats
`expiresAt`, and `providerSpecificData` merges — replacing it drops GitHub's non-token fields and
logs the account out. `quotaProxyOptions` pins `strictProxy: false` so a dead proxy cannot report
a healthy account as broken.

Verification: 635 files / 7371 tests, both packages `tsc` clean, `biome check` clean, build exit 0.

Remaining in `usage`: `providers`, `stream`, `token-savings`, `stats`, `logs`, `request-logs`,
plus `[connectionId]/claude-reset` and `codex-reset-credits` (which already have their own tests).

**`available-models`: catalog health rules moved to `domain/available-models.ts`.** 360 lines of
handler code held six nested closures — `isDisabled`, `pluginMarkResolver`, `activeLocks`,
`providerKeys`/`providerStatus`/`modelLockStatus`, `memberStatus`, `lookupContext`/`comboContext`.
The handler now assembles rows; the health rules are named domain functions.
`lib/usage/availableModels.ts` keeps `filterModelsByAllowedModels` and `collapseModelsByAdmittedId`
because `availableModelsSelfCheck.mjs` imports that file directly — moving it would break a script
that runs outside bun.

Writing the tests found **a bug that was already in the route**: `modelLock_*` column suffixes are
snake_cased model ids (`gpt-4o` → `modelLock_gpt_4o`), but the lock check compared the raw id. A
model genuinely cooling down therefore reported `limited` instead of `cooldown` — a wrong answer
that looks like a healthy connection. `lockKey` now folds `.`, `-`, `:` to `_` before comparing,
and the test covers `claude-3.5-sonnet`, `claude-3-5-sonnet`, and a sibling that must stay
`limited`.

Two answers in the old code were right and are now written down where they live: a provider with
*no* connection row reports `ready` (credential-free providers serve without one — reporting them
unavailable hides every free model), and an unrecognised status normalises to `ready` rather than
hiding the model. `comboStatus` also gained an explicit `isCombo` probe instead of testing the
members array for truthiness, which could not tell "a combo with no members" from "not a combo".

Verification: 51 new tests, `tsc` clean on both packages, build exit 0.

**`providers`: label priority named.** `providerLabel` states the order the old map callback implied —
node, then catalog, then the id — and treats a blank name from any source as absent. A node saved
with an empty name is not a name, and falling back beats a blank row. `providerOptions` collapses
duplicates and trims padded ids. The row keeps the label under both `name`/`nodeName` and the logo
under both `logo`/`nodeLogo` because the Usage filter and the request-details filter each read a
different one of the pair. 12 tests; `4cdda0dc0`.

**`codex-reset-credits`: five verdicts named.** `consumeOutcome` maps a failed consume to a 4xx
passthrough or a 502 (was 500 for both — this service could not get an answer, it did not break).
`isAuthExpired` now reads `{error: {code: "401"}}`, the shape the upstream most often uses and the
one a message-only check missed. `codexEligibility` separates 404 (no such connection) from 400
(not Codex, or no OAuth/access-token credential) and returns `isOAuth`, so an access-token
connection is no longer refreshed first. `canRetryAfterExpiry` states the retry rule once: one
retry, OAuth only, refresh token required. `codexProxyOptions` pins `strictProxy: false`.

The route's own test file (`codex-reset-credits.test.ts`, mocked upstream) passes unchanged; the
24 new tests in `codex-reset-credits-rules.test.ts` cover the verdicts. `2dc280342`.

**What is actually left in `usage`.** An audit of all 19 route files shows the batch is finished
apart from two exemptions the plan already records:

| Route | Why it stays |
| --- | --- |
| `stream` | SSE — oRPC JSON serialisation destroys a stream |
| `token-savings` | the handler is 21 lines and delegates to `open-sse/rtk/tokenSaverStats` |

`stats`, `logs` and `request-logs` were already delegating to `application/usage/report-usage.ts`
before this batch, so "remaining" in earlier notes was wrong. Nothing in `usage` is left to port.

Verification: 638 files / 7458 tests passing, tsc clean on packages/db, apps/api and apps/web,
biome clean, build exit 0.

**`notifications`: the dedupe and dismissal rules.** `e1cdaefd7`. The feed is idempotent in both
directions and both directions were loops inside handlers. The rule that could not be read from
the code: `staleQuotaKeys` is driven by the **key list**, not by the notices found. That is the
recovery mechanism — a key back under budget produces no `quotaPressure` at all, so a sweep over
notices would never see it and the stale warning would stand forever. The old nested loop happened
to be right; nothing said so, and the obvious "simplification" breaks it.

The sweep also runs across the full cross product of kinds and levels, which retires a notice when
a key switches budget kind. `notificationCommand` separates three shapes that all mean "a notice
goes away": `read` with no id (mark-all; treating it as a no-op leaves the badge stuck), `clear`
with an id (dismissed row), `clear` with kind + dedupeKey (a condition the scan found to be over,
possibly a row never seen). Getting those backwards silences a live condition instead of retiring a
dead one. 33 tests.

**`headroom`: one copy of the lifecycle rules.** `7dbe05393`. `start` and `restart` were
byte-identical apart from which process function they called, including a duplicated
`parsePortFromUrl`. Two decisions are load-bearing: only a loopback URL may be started here (a
local process for a remote URL is a proxy the dashboard reports healthy while every request
bypasses it), and NOT_INSTALLED is 400 because a 500 tells the operator to retry something that
cannot work until they install Headroom. Error-code sets are per-operation and visibly different —
uninstall does not own NOT_INSTALLED, since there is nothing to remove.

`headroomPortFromUrl` returns null for a URL with no explicit port rather than 80/443: Headroom's
own reads go through that value. `headroomStopStatus` keeps 409 for nothing-to-stop. Nothing was
copied into the domain — `isLoopbackHeadroomUrl` and `DEFAULT_HEADROOM_URL` stay in
`lib/headroom/detect`, which already owns them. 20 tests.

**`media-providers`: the voice picker's grouping, written five times.** `df79f4bf3`. Five TTS voice
routes answer `{ languages, byLang }` and each wrote its own bucket loop, its own
`Intl.DisplayNames`-with-fallback, and its own name rule.

The rule that was missing, not just unnamed: **a voice belongs to every language its provider
verified, not only its primary one.** ElevenLabs states the primary in `labels.language` and the
rest in `verified_languages`; only the primary was read, so a voice speaking English and Spanish
could not be reached from the Spanish list — a working voice the picker hid.

Two bugs surfaced only because the rules got names:

1. `Intl.DisplayNames` **recognises `Custom` as a language tag** and answers `custom`, lowercase.
   The MiniMax bucket would have rendered as `custom`. It is not a language, so the sentinel keeps
   its spelling.
2. A voice with no id produced a bucket keyed `undefined`. `voiceId` returns `""` and MiniMax skips
   it — there is no id to select.

Also named: `?lang=` with an unknown code returns nothing, never everything (a typo must not look
like a successful filter); a voice whose provider lists no language lands under `en` rather than
being dropped from every filter; duplicates are dropped *inside* a bucket but the same voice
legitimately appears in two. 24 tests.

**`translator`: the file allowlist gets one copy.** `f0d1b54`. `load` and `save` each carried their
own eight-entry list of permitted dump files. Two copies of a security boundary is one copy that
eventually diverges — and the divergence is silent: a file added to one side saves and then cannot
be reopened. The comparison is an exact match, because the `../` traversal happens later in
`path.join`, after any pattern test has passed.

`send` answered 500 when the connection dropped. That tells the operator the dashboard broke, when
in fact nothing was learned about the provider — 502. Provider statuses still pass through, since a
429 must stay a 429 or rate limiting reads as a dashboard fault. `translatorTarget` made explicit
that step 3 cannot infer the provider (the model id in an already-translated body may belong to
any provider) and `translatorRefreshUsable` named the retry gate that was correct but unreadable:
a partial refresh would resend the same rejected token. 19 tests.

**`auth`: the rules that make dashboard login safe.** `9e4b8b7`. The login handler was 280 lines with
four security decisions encoded as control flow, each with a failure mode that does not look like a
failure from outside:

- **An exhausted quota still signs in.** `validateApiKey` answers `QUOTA_EXCEEDED`; the tempting
  reading is "reject the credential". But the usage page is where the bar sits at 100%, so refusing
  the session hides the state the operator needs to see. `apiKeyAdmitsSession` states that this is
  a pass — and that an *unrecognised* verdict is not.
- **A fresh install's published default earns no remote session.** `123456` is in every README;
  issuing a JWT for it lets anyone authenticate and then `PATCH /api/settings` to disable
  authentication. `mustChangeDefaultPassword` enumerates the four reasons a login is not that case.
- **SSO only refuses passwords when it is actually configured.** `authMode: "saml"` with no entry
  point is half-finished, and refusing there locks the operator out of their own dashboard.
- **A wrong API key burns the same attempt counter as a wrong password**, or the key path is a free
  guessing oracle while the password path is throttled.

Two bugs found while naming:

1. `isTunnelRequest` called `new URL(settings.tunnelUrl)` unguarded — one malformed settings value
   threw and took down the login route, so the gate became the outage.
2. OIDC and SAML `catch` blocks put `error.message` into `?error=`, which lands in the address bar
   and browser history. Our own failures now get a fixed slug; a *provider's* error is still
   forwarded, because that is the operator's only diagnosis.

`dashboard-session.ts` names the six cookies that logout, both starters and both callbacks must
agree on, and states that a handshake missing its nonce or verifier is not degraded — it cannot be
verified at all, so it is refused before any code is exchanged. `saml-start-prerender.test.ts` was
asserting a literal cookie spelling; it now asserts the behaviour it exists to protect. 46 tests.

**`mcp`: the plugin allowlist and the dead-bridge status get names.** `6d4f68ddb`. The `[plugin]`
segment is caller-supplied and indexes a registry that forks a child process, so the preset list is
the entire defence against an arbitrary spawn — yet it lived inside the bridge library while the
routes only asked "does this exist?", one call away from looking like a lookup. `resolvePlugin` is
now the single verdict, 404 rather than 400 because the segment names a resource.

Also named: the `sessionId` on POST decides nothing (the child's stdin is shared, replies broadcast,
so missing/stale/foreign ids are equivalent — writing that down stops a future reviewer from
"fixing" it into a client-breaking check that prevents nothing), and a forwarded message answers 202
while a dead bridge answers 502 rather than 500, because the child exited between subscribe and POST
and the client should resubscribe rather than resend. 12 tests.

**Session total — resources after `usage`, all landed:** `notifications` (2 routes), `tags` (1,
static catalogue + CORS, no rules to name), `headroom` (5), `media-providers` (5), `translator` (6),
`auth` (11), `mcp` (2). Eight new domain modules, 965 lines, 117 new tests.

Four real bugs surfaced, every one invisible before the rules had names:

1. ElevenLabs voices reachable only from their primary language, hiding multilingual voices.
2. `Intl.DisplayNames` relabelling `Custom` as lowercase `custom`.
3. `isTunnelRequest` throwing on a malformed `tunnelUrl`, turning a login *gate* into a login outage.
4. OIDC/SAML `catch` blocks putting `error.message` into the `?error=` redirect, which lands in
   browser history.

One test was made honest: `saml-start-prerender.test.ts` asserted a literal cookie spelling and now
asserts the behaviour it exists to protect.

**`auth` SSO probes: an endpoint that could not lie about what it found.** `e9c4b0d`. The two "test
this configuration" endpoints exist so the operator finds out their IdP settings are wrong *before*
saving them and locking themselves out. Naming their rules turned up three bugs:

1. **A blanked field resurrected the saved value.** Both routes did `body.x || settings.x`, so
   `{samlCert: ""}` — the form saying "I cleared this" — fell through to the stored certificate. An
   absent key and an empty string mean opposite things; only `Object.hasOwn` tells them apart.
2. **The entry point accepted `javascript:`.** The old check was `new URL(entryPoint)` in a
   try/catch, and that parses fine — the value is handed to a redirect.
3. **`saml/metadata` emitted an unescaped error body.** The failure response is XML because the
   operator pastes it into an IdP; one `&` from a certificate path broke the document and made a
   configuration error look like a broken URL.

The access gate (`requireLogin === false` opens it, otherwise a session) was copied verbatim into
both routes. `probeAccess` takes the session verdict as an argument, keeping the module free of
cookies. The OIDC verdict distinguishes "discovery worked, secret did not" from "discovery broke",
because those are two different fixes; it answers 200 with `ok: false` in the body. 31 tests.

**Plan corrected.** The `(107 more) pending` row was stale — measured by delegation, 156 of 168
handlers are ported. The 16 that remain are recorded decisions in `task_plan.md`: stream bodies
(oRPC destroys them), fan-outs with no rules, static/liveness endpoints, and one route that is a
single call into an existing normaliser.

Verification: 647 files / 7636 tests passing (74 skipped), tsc clean on `packages/db`, `apps/api`
and `apps/web`, biome clean, build exit 0.

**`settings`, `mitm-alias`, `oauth/kiro` — the last three routes with rules.** `894eddaef`, `61df595a3`.

`proxy-test`'s whole verdict was inline: pass the probe's status through (a 407 from the proxy is a
diagnosis; a 500 sends the operator to the wrong machine), fall back to 500 only when the probe
reported no status, and read `AbortError` as a timeout rather than a crash. `proxyProbeAnswer` owns
it now.

`kiro/import-cli-proxy` guessed its envelope (`cliProxyAuth ?? auth ?? json ?? body`) inline. Kept,
with the reason recorded: rejecting unknown shapes there would pre-empt the normaliser, which is the
component that knows which fields are mandatory and can name one. The summary echoes id/provider/
email only — an import response is the last place a refresh token should reappear.

**`changelog` was serving the wrong changelog, silently.** `readLocalChangelog` reads
`process.cwd()/CHANGELOG.md`. I ran `readFileSync` from the assembled tree at
`apps/web/.next/standalone/apps/web`: `LOCAL FAIL ENOENT` — the directory holds `custom-server.js`,
`server.js`, `src/`, `open-sse/`, `migrations/` and no changelog. The route's `catch` turned that
into a fallback, so the standalone dashboard showed upstream's release notes and dropped this
build's own, with no error anywhere. Fixed in the publisher, not the reader:
`assemble-standalone.sh` copies the file and lists it in preflight, beside `dashboardGuard.js`,
which is missing for the same reason — Next's trace cannot prove a runtime-built path is needed.
`changelogPayload` now keeps the two panes independent and turns a whitespace body into `null`
rather than an empty pane under a heading.

**`mitm-alias` promised what the proxy could not deliver.** An alias only fires for a tool whose DNS
routes through the local MITM proxy. With DNS off, `PUT` stored the mapping, answered
`{success:true}`, and the alias never fired. The 403 existed but as an unnamed `if`, so nothing
recorded why. `aliasWriteRefusal` owns both verdicts (400 before DNS is consulted, 403 naming the
toggle), and `sanitizeAliasMappings` drains the editor's always-present blank row — storing `""`
would create an alias that rewrites the model to nothing. The alias *key* stays verbatim: it must
match exactly what the tool sends.

**Sweep closed.** 167 of 174 handlers outside `v1/`/`v1beta/` delegate to `apps/api`. The seven left
are three stream bodies, two fan-outs, and two liveness endpoints — decisions in `task_plan.md`, not
a backlog. `Next Step` now points at what the sweep deferred: the delegating handlers still return
`NextResponse`, so the oRPC transport half of Phase 8 has not started.

Verification: 40 new tests across the two commits, 651 files / 7676 tests passing (74 skipped), tsc
clean on `packages/db`, `apps/api`, `apps/web`, biome clean, build exit 0.

**Audit of the trace-blind path class: MITM could never start from a build.** `4dece3ecf`. The
CHANGELOG bug generalised, so I enumerated every runtime-built path and checked each one against the
assembled tree instead of reading code:

| Path | Standalone | Verdict |
| ---- | ---------- | ------- |
| `scripts/auth-guard-hooks.mjs` | present | ok |
| `src/dashboardGuard.ts` | present | ok |
| `migrations/` | present | ok |
| `open-sse/lib/deepseek-pow-worker.mjs` | present | ok |
| `logs/` | absent | fine — `mkdirSync(recursive)` on first write |
| `CHANGELOG.md` | absent | fixed in `894eddaef` |
| `src/mitm/server.js` | **absent** (`server.ts` only) | fixed here |

`resolveBundledServerPath` tested `existsSync` on `server.js` at three locations and fell through to
a path that did not exist; `bootstrapMitm` probed `join(appSrc, "mitm", "server")` with no extension.
Both answered `false` on the real tree — I ran them there: `existsSync(server)` false,
`existsSync(server + ".ts")` true.

Resolving `.ts` alone would not have been enough. The child is
`spawn(process.execPath, [effectiveServerPath])`, and node cannot execute TypeScript, so the fix
ships JavaScript: esbuild bundles `src/mitm/server.ts` in both the `postbuild` step and
`assemble-standalone.sh`, matching what `cli/scripts/buildMitm.js` already does for the CLI.

**The first attempt was wrong and the verification said so.** Transpiling only the entry produced a
file whose first import failed: `Cannot find module .../antigravityIdeVersion.js` — six siblings exist
only as `.ts`. Bundled instead: zero relative specifiers, only `node:*`, `node --check` passes, and
the resolver finds it from inside the tree.

The `standalone-assets` fixtures called the staging function without `await`; making it `async` broke
two of them for real, which is the test working. Both await now, plus two new cases pinning the
bundle rule.

Verification: 652 files / 7682 tests passing (74 skipped), tsc clean on all three packages, biome
clean, build exit 0 with the bundle staged.

## oRPC server made real (apps/api/src/main.ts)

`main.ts` passed `session: null` to every request, so all 61 procedures would have
answered 401. Three separate defects sat between "the process starts" and "the
server serves", and each one was silent:

| Defect | Symptom | Fix |
| ------ | ------- | --- |
| no session resolution | every dashboard call 401 | `resolveSession` verifies the `auth_token` JWT per request |
| `process.cwd()` as the key directory | a **second** `jwt-secret` minted in `apps/api/`, every valid cookie rejected | `getDataDir()`, the rule the database already uses |
| migrations resolved from cwd | `Migration journal not found` → every call 500 | `MIGRATIONS_DIR`, set by `main.ts` before the graph is built |

**The catalogues were the trap.** I first wrote `registry-host.ts`,
`catalogue-host.ts` and two `unavailable-*` stubs, because `useCases` needs
`registryHost`, `catalogueHost`, `relayDeploy` and `proxyImportJobs` and those live
in `apps/web`. That was wrong: `apps/web/src/lib/useCases.ts` supplies **all** of
them already. Rebuilding the list in `apps/api` meant either importing the same
modules anyway or substituting refusals for working ports — a server answering 200
with an empty catalogue. Measured instead of guessed: `getUseCases()` loads under
Bun and builds **64 use-cases** with the real ports. The four stubs were deleted.

One thing genuinely does not resolve outside Next: `server-only`. It is a marker
Next supplies during its own build, absent from disk, so the import died with
`Cannot find package 'server-only'` — an error about resolution, not about the
problem. Installed for real (`server-only@0.0.1`, MIT) and run with
`--conditions=react-server`, its documented server branch.

### Verified by request, not by port

```
POST /api/apiKeys/list   no cookie   -> 401 UNAUTHORIZED
POST /api/apiKeys/list   valid JWT   -> 200 []
POST /api/usage/stats    valid JWT   -> 200 {"totalRequests":27,...}
POST /api/settings/loginGate         -> 200 {"requireLogin":true,...}
POST /api/combos/list                -> 200 {"combos":[{"id":"cb1",...}]}
```

An early "401 means auth works" reading was wrong — a 401 is also what a broken key
returns. Only a 200 carrying real rows proves the key is shared and the database is
reachable. `tests/unit/api-session-key.test.ts` (7 cases) pins the key-directory
rule so it cannot regress.

`apps/api/tsconfig.json` gained the alias map `apps/web` uses (`@/*`, `open-sse/*`,
`@9router/*`) plus `types: ["node","bun"]`. The `bun` types exposed one real
collision: `bun-types` declares `fetch.preconnect`, so assigning the gateway's
wrapper to `globalThis.fetch` failed. One cast, as Bun's own docs prescribe.

Verification: 653 files / 7698 tests passing (74 skipped), tsc clean on api and web,
server answers 200 with rows.

## The dashboard could not reach its database in dev (found by wiring oRPC)

Wiring the first oRPC client exposed a defect bigger than the client itself:
**`bun run dev` could not serve any database-backed route.** Every one answered 500
on `Migration journal not found at apps/web/migrations`.

`apps/web/src/lib/useCases.ts` passed `process.cwd() + "/migrations"` to the
migrator unconditionally. That path exists only in a standalone build. The migrator
treats an explicit path as authoritative and *stops* when it is missing — it never
falls back to its own upward search — so the whole dev tree was dead.

Why it went unnoticed: `/api/theme` answered 200. It catches its error and replies
with the default theme, so a broken install reads as a working one — it was returning
`glass` when the stored value was `dark`. The route was failing the entire time.

The fix has two halves because dev and production fail differently:

| Context | Why the search fails | Fix |
| ------- | -------------------- | --- |
| dev (`next dev`) | explicit `apps/web/migrations` does not exist | pass `undefined` unless the path exists, so the ascent runs |
| standalone | bundler rewrites `import.meta.url`, so ascent starts in `.next/server/chunks/` | `custom-server.ts` sets `MIGRATIONS_DIR` from its own `__dirname` |

Both verified by request: dev `/api/settings` 500 → 200; standalone `/api/settings`,
`/api/combos`, `/api/theme` all 200. `tests/unit/migrations-journal-lookup.test.ts`
(4 cases) pins the ascent, including that a `migrations/` directory with no `.sql` in
it is not a journal.

**Editing `custom-server.js` was wrong**: it is generated from `custom-server.ts` by
`copy-standalone-assets.mjs`, so the change vanished on the next build (grep for
`MIGRATIONS_DIR` in the bundle returned 0). The source is the only file to edit.

## oRPC client: proven in-process on combos

`apps/web/src/lib/orpcClient.ts` builds a `createRouterClient(appRouter, { context })`
bound to one request's session — in-process, so no HTTP hop, no second session
resolution, and no requirement that the API server be running for the dashboard.
A fresh client per call, never cached: a cached one would serve the first caller's
session to everyone after.

`/api/combos` now goes through `combos.list`/`combos.create` instead of calling
use-cases directly. Verified end-to-end: `POST` 201 with a real id, `GET` returns it,
`DELETE /api/combos/[id]` 200, row gone.

`9router-api` gained a `./presentation/orpc/router` export; `apps/api` `dev`/`start`
scripts gained `--conditions=react-server`, without which both crash on `server-only`.

## usage: the transport move was safe only after the scope moved

`usage` did not go the way `combos` did, and the difference is the whole lesson.

`combos` was safe because its procedures called the same use-cases with the same
arguments. Checking `usage` for that same property is what caught the problem
before any route was touched: every procedure passed a constant
`{ apiKeyFilter: null, allowedModels: "*" }`, while the REST route passed
`usageScopeOf(ctx)`. Moving the route would have widened an API-key session from
its own usage to every key's. The transport move is not uniformly mechanical — it
has argument-equivalence as a precondition, and here it failed.

So the order inverted: the scope moved first (`base.ts` gained `SessionClaims`,
`usage.ts` called `usageScopeOf(context.session)`), the routes moved second. The
first commit is the one a reviewer should read; the second is wiring.

Verified at the port rather than in types — two sessions through the real router
now pass different scopes down:

    password session -> { apiKeyFilter: null, allowedModels: "*" }
    apikey session   -> { apiKeyFilter: "sk-alpha", allowedModels: "gpt-4o" }

`sessionClaimsOf` exists because the combos route had hand-written that mapping
and dropped `apiKeyFilter` — the same defect, one route earlier, caught by looking.

Gates: typecheck 0, 7714 passed / 0 failed (5 new), all six routes 200 against a
live dev server, `?period=90d` still 400 with the rule's own message, CSV still
`text/csv`.

Restored two files that were dirty but not mine: `apps/web/tsconfig.json`
(reformatted by `next dev`, plus `.next-dev` include entries) and `apps/web/AGENTS.md`
(written by Next 16 on first boot). Neither belongs in a commit about routes.

## keys: the same defect as usage, but the constant was an identity

`usage` hardcoded a scope; `dashboard-keys` hardcoded the caller as
`{ role: "admin", permissions: null }`. The role is not a label the rules ignore —
`mayCreateSubKey` returns `true` for anything that is not `apikey`, and
`permissionsForSubKey` grants what was asked for on the same condition. So adopting
the router as written would have let a key session without `manageApiKeys` mint keys
and one with it grant permissions it may not grant.

Two gaps in the same router, found by comparing it to the route line by line:

1. The caller constant (above).
2. `list` returned `dashboardKeys.list()` raw, skipping `visibleApiKeys` and the
   `createdBy` blanking that stop one session reading another key's secret.

Fixed both in `fix(keys)` before touching a route. `callerFromSession` is now the one
translation; `presentedKeys` filters and labels. Verified at the port: password
session sees 4 keys, `sk-alpha` sees its own + the child it made, no secrets in the
payload.

Incidental fix: `create` spread `{...created.key, secret}` and shadowed the view's own
`key`. The LSP caught it — `key.name` did not compile.

The measurement that made this legible was cheap: call the domain predicates with
each caller shape and print the verdicts. That table is in the commit body, and it is
what turned "this looks mechanical" into "this is a privilege escalation".

Gates: typecheck 0, 7722 passed / 0 failed (8 new), and a full CRUD cycle against a
live dev server — 201, 200, 200, 200, 404 — plus 400/409 refusals carrying their own
wording. Test keys created during the probe were deleted; the table is back to 5.

## theme: a third shape of the same defect

`error-logs` need no work — its procedures take no caller argument, so it was
equivalent from the start and moved in one step.

`theme` had two defects and neither was a constant:

1. `get` was `authed` while the route is public on purpose. The login page applies the
   theme before a session exists, so adopting the procedure would have broken the one
   screen a signed-out user sees.
2. `set` took `role` from the request body. `refuseThemeWrite` refuses an empty role
   and `"apikey"` and accepts everything else, so a caller stating `role:"admin"`
   defeated it. A key session could write the site-wide theme.

Verified live: `GET /api/theme` is 200 with no cookie and `no-store`; a key session
POSTing `role:"admin"` gets 403 with the rule's wording; anonymous POST is 401.

The generalisation has now held three times: **a procedure is equivalent to its route
only when it derives the same value from the same source.** A literal (`usage`), a
constant caller (`keys`), an input field (`theme`) and an over-strict gate (`theme`)
all fail that test, in different ways. Read what the procedure feeds the rule and who
is allowed through the door — not just what the rule says.

Gates: typecheck 0, 7729 passed / 0 failed (7 new).

## `pricing` — and the correction that came with it

The migration itself was the smallest so far: three procedures, one route, no handler
reads the session. `GET` returns catalog+overrides, `PATCH` writes `{provider: {model:
{input, output, ...}}}`, `DELETE` reads `?provider=`/`?model=`. Live: 200 with a session,
401 anonymous, and `DELETE ?model=` without a provider still refuses with its own
wording ("A model reset also needs the provider").

The work that mattered was undoing my own change from earlier in this session.
`pricing.get` had been switched from `authed` to `base`, on the strength of its
docstring saying "public at the REST layer" and its handler not calling
`getSessionContext()`. Both observations are true and the conclusion was still wrong.

`dashboardGuard.ts` denies every `/api/*` path by default; reachability comes from
`PUBLIC_API_PATHS`, which holds ten entries and `/api/pricing` is not one of them. So a
`base` procedure would have been callable anonymously through oRPC while the REST route
stayed 401 — the procedure weaker than the route it mirrors. Reverted.

Re-checked all twelve migrated areas against the allow-list afterwards: exactly one is
public (`/api/theme`), and it is the one the guard's own comment explains — "one
non-sensitive value that every visitor needs before sign-in; writing it is checked
inside the route". `theme.get` = `base`, `theme.set` = `authed` is right by that
reading, not by the docstring.

Then the test. The first version read only the guard and asserted things about the
allow-list; I sabotaged `pricing.get` back to `base` and it passed 5/5. A test that
cannot fail on the mistake it was written for is not a test. Rewrote it to read the
routers and collect every `base.handler` declaration, so the assertion is "no procedure
is public on a guarded path". Same sabotage now fails with
`expected [ '/api/pricing:get' ] to deeply equal []`.

Gates: typecheck 0, 7735 passed / 0 failed (6 new).

## `models` and `pxpipe` — six routes, one refusal, and a status-code regression

`models` (2 methods), the six `models/*` sub-routes, and the four pxpipe controls all
delegate to procedures that already existed. The pattern from `pricing` held: no handler
reads a session, no path is public, so the client carries the session and the procedures
stay `authed`.

Live at the port, with a password session: catalogue 200, alias/availability/custom/
disabled/catalog-sync 200, pxpipe status/logs/health 200 on both GET and POST, anonymous
401 from the guard. `?limit=` still obeys the router's rule — `2` honoured, `abc`→100 with
`adjusted: true`, `999999`→500 — which is how I know the argument survived the hop, since
`null` and absent are the same to the old use-case but not to `z.string().optional()`.

**The batch found a status-code regression that only the migration could reveal.** Six
routes answered 500 for a body the caller got wrong. `statusOf` mapped `VALIDATION` but
not `BAD_REQUEST`, the code `@orpc/server` throws from `validateInput`. The old shape was
`route → use-case`, where `invalid()` supplies the code; adopting a procedure moves
validation one step earlier, into the transport, so it refused before the use-case could
produce the code the table understood. Fixed in the one mapping table.

**One route stayed unmigrated on purpose.** `POST /api/models/catalog-sync` calls
`catalogueSync.runNow()`, and the `models` router has no such procedure — deliberately,
its header says starting a sync is absent because the transport is reachable with an API
key and a sync rewrites the catalogue. Recording the reason in the route file is the
point: the next person to notice the gap reads it instead of filling it.

**A pre-existing bug, found and left alone.** `PATCH /api/pricing` accepts
`{provider: {}}` and writes a provider literally named `"provider"`, because
`parsePricingUpdate` validates each provider's value but never its name. The
pre-migration route called the same use-case, so this is not the migration's doing.
Recorded in findings rather than fixed: whether an unknown provider should be refused is
a policy question, not a cleanup. The probe row was deleted.

`tests/unit/sidebar-usage-ownedby.test.ts` needed retargeting: it pinned the literal
`customModels.add(await request.json())` to prove `ownedBy` is not dropped. The assertion
now pins the same intent against the new call — body reaches `custom.add` whole, route
never mentions `ownedBy`.

Gates: typecheck 0, 7735 passed / 0 failed.

## `providers` — the first router built from scratch, and the cost of that

`providers` was not in `appRouter` at all. Twelve namespaces existed; this one did not. So
the work was not adoption but creation: five procedures (list/get/create/update/remove),
two routes delegating to them, and a new namespace registered in `router.ts`.

**The caller question finally has a real answer, and it is "no".** `connections.list()`
takes no caller argument and strips secrets in the use-case's own `toResponse`, so there
is nothing to narrow. That is the opposite of `usage` (`null` filter widening a key's
report to every key) and `dashboard-keys` (`role: "admin"` clearing a sub-key gate). The
router comment records the contrast so the next reader does not re-derive it.

**A 409 became a 500, and no type checker could see it.** The store refuses a duplicate
name by throwing a plain error with `code: "PROVIDER_NAME_CONFLICT"` plus the id and name
of the row holding it — `existingId` is what lets the dashboard offer "edit the existing
one instead". `toORPCError` turns any non-`AppError` throw into `INTERNAL` with a generic
message, so the transport flattened it. Found by creating the same name twice at the port;
the second answered 500.

Fixed at the layer that already speaks the store's vocabulary: `nameConflictAsDomainError`
in `manage-connections.ts` converts it to `conflict(...)`, carried on both create and
update. `AppError` gained an optional `data` field, distinct from `detail` — `detail` is
for the log, `data` is what a client acts on — and `toORPCError` forwards it. Then
`isNameConflict` learned to read both shapes, since the raw store error is still what a
direct in-process caller sees. Verified after: 201, then 409 carrying `existingId` and
`existingName`, unknown provider still 400, count back to 73.

**Three tests needed the session mocked.** They already fake `next/server` and
`@/lib/useCases` because building the real graph opens a second SQLite handle; the session
is now part of that same wiring. Without it `cookies()` throws "outside a request scope"
and they fail for a reason unrelated to what they assert. I considered making the route
tolerate a missing scope — and rejected it: a route that silently proceeds without a
session is exactly the class of bug this migration keeps finding.

**Ten provider routes remain, deliberately.** `models`, `overrides`, `test`, `test-models`,
`test-batch`, `validate`, `web-login`, `client`, `kilo/free-models`, `suggested-models` —
a larger surface, several reaching the network. A half-populated namespace would read as
done, so they are their own step.

Gates: typecheck 0, 7735 passed / 0 failed.

## providers: the remaining ten

All ten routes are on oRPC: `[id]/models`, `[id]/overrides`, `[id]/test`,
`[id]/test-models`, `client`, `kilo/free-models`, `suggested-models`, `test-batch`,
`validate`, `web-login`. The namespace now holds eighteen procedures and the route files
are three-line delegations.

**Two of the ten carry a status the code cannot express.** `list-provider-models.ts`
raises `ProviderRefusal` with whatever the provider answered, and `check-connection.ts` can
run past its ceiling. Neither is a `BAD_REQUEST`/`NOT_FOUND` story, so
`ProviderRefusal` now extends `AppError` and passes its status through; `toORPCError` lets
a carried status win over `statusFor(code)`, and `statusOf` on the web side does the same
before falling back to the code table. Without both halves a 429 became a 502 and a 504
became a 500 — the panel would have told the operator to open a ticket instead of waiting.

**Not every route could become a bare round-trip.** Three still shape their answer:
`kilo/free-models` switches on `kind` so "fresh", "cached", "stale" and "failed" stay
distinguishable (and a failure is a 502, not a 500); `suggested-models` decides which of
`stale`/`error`/`syncedAt` to include; `web-login` POST answers 202 because starting a
login is not completing one. Those are statements about the HTTP response, so they belong
in the route — the use-case does not know it is being spoken to over HTTP.

**`testBatch` types `mode` but does not enumerate it.** An enum in the Zod schema would
answer "invalid input" where `test-connections.ts` answers "use one of these three modes".
Validation moved into the transport once and cost six routes their 400s; the lesson generalises
to messages, not just statuses.

**`webLogin` is four procedures behind the same password session.** `begin` opens a headed
browser on the host, which is exactly the kind of capability that must not be reachable
with an API key — it stays inside the guarded namespace, and `/api/providers/web-login` is
not on `PUBLIC_API_PATHS`.

Gates: `tsc` clean in both `apps/web` and `apps/api`.

## `settings` — eleven routes, and the one credential the body must not carry

All eleven settings paths are on oRPC: `read`/`write` (`/api/settings`), `loginGate`
(`require-login`), `history.list`/`history.read`/`history.revert`
(`/api/settings/history`, `/rollback`), `autoBackup.{read,write,sendNow}`
(`/api/settings/auto-backup`), and `database.{read,write,startJob,readJob}`
(`/api/settings/database`, `.../jobs`, `.../jobs/[jobId]`).

**`context.headers` went from optional to required, and that was the point.** The four
database procedures read `x-9r-password`, `x-9r-cli-token` and `x-9r-poll-token` off the
request. If a caller may omit headers, then `database.write` has a code path where a
restore proceeds with no credential at all — a hole that typechecks. Making the field
required turned that hypothesis into 35 compile errors across the app, which is the only
reason every other route now demonstrably forwards `request.headers`.

**The body carries the password, and the header decides.** `POST /api/settings/database`
posts JSON `{password, database}` because the browser cannot send a form with a dump that
size; `POST .../jobs` does the same. So the credential exists in two places for one call,
and it is easy for the procedure to trust the body's copy — which a script can set to
anything. `credentialsFrom(request.headers)` stays the only source of truth; the body
password is the *document* being restored, checked and stripped before the write.

**`GET .../database?summary=true` needs no credential, and is still guarded.** The login
screen reads the summary before anyone signs in, so the use-case must allow it — but
`/api/settings/database` is not on `PUBLIC_API_PATHS`, so `dashboardGuard` answers 401
before the handler runs. Both statements are true and only one of them is reachable; the
use-case branch exists for the internal callers, not the HTTP path. Passing the raw query
string through rather than parsing `summary` in the route keeps that decision in one place.

**A 202 stays in the route.** `POST .../jobs` answers 202 because *starting* a restore is
not *completing* one. The use-case returns a job, not a restore, so the status is the
route's to choose — same rule as `web-login`.

**`sessionRole()` is gone.** It existed to read one field of the session for the routes
being migrated; once none called it, it was dead code, and dead auth helpers are worse than
dead utilities because they look like an access-control path. `grep -rn sessionRole
apps/web/src tests` now finds only two local variables in components.

Gates: `tsc` clean in both `apps/web` and `apps/api`; `apps/web/src/lib/sessionRole.ts`
deleted.

## `oauth` — sixteen of twenty, and the two that must not be procedures

Sixteen routes now go through `oauth.*`: the twelve `credentials.*` importers
(`codex/import-token`, `cursor/import`, `kiro/import`, `zed/import`, `{kiro,xiaomi-mimo}/api-key`,
`{codex,grok-cli}/bulk-import`, `{kiro,xiaomi-mimo,zed,cursor}/auto-import`) plus
`gitlabPat`, `iflowCookie` and `kiroSocial.{authorize,exchange}`.

**The refusals needed a third mapping path.** `importToken`, `importApiKey`, `importBatch`,
`gitlabPat`, `iflowCookie`, `kiroSocial.*` and `startMimoLogin` all answer
`{ ok, status, error }` instead of throwing, and the status is the provider's — 401 for a
refused token, 409 for a key Kiro already holds, 502 for an unreachable upstream. That is
the `ProviderRefusal` problem again in a second family, so `orRefuse` in
`presentation/orpc/refusal.ts` throws an `AppError` carrying `status`. Without it every one
of these would have become a bare 200-with-error-body, which is worse than a 500: the panel
would show a green toast.

**`bulkImport` and `autoImport` are not refusals, and `orRefuse` would have been wrong.**
`BulkImportAnswer` answers counts — "three of five imported" is a 200, and an error status
would hide the three. `CredentialSearch` answers `{ found: false }` — nobody has logged into
Kiro yet is the expected state on a fresh install, not a failure. The type checker caught
both when `orRefuse` demanded `ok`; the lesson is that "returns a status" and "is a refusal"
are different questions.

**`iflow/cookie` was calling bare `fetch`.** It passed `fetchImpl: fetch`, so the SSRF guard
never ran on a path whose upstream host comes from the request. Routing it through the same
`fetchForCaller` as the GitLab PAT closed a real hole rather than merely tidying.

**`fetchForCaller` is `required`, not defaulted.** The obvious fallback (`() => fetch`)
silently skips the guard. A host with no opinion now has to write `() => fetch` where
someone will see it.

**Four routes stay where they are, by decision.** `[provider]/[action]` (`authorize`,
`start-proxy`, `device-code`, `register-session`, `exchange`, `poll`, `manual-code`),
`kiro/import-cli-proxy`, `xiaomi-mimo/login/start` and `login/status`: they mint in-memory
OAuth sessions and set an httpOnly cookie the browser must receive. A cookie is not a value
a procedure may return, and turning `beginSession` into procedure input would put a
credential on the caller's side of the boundary — the same mistake the database routes
avoid with headers. They keep calling the provider layer directly until there is a port
that returns the cookie as transport state.

Gates: `tsc` clean in both `apps/web` and `apps/api`.

## tunnel, headroom and media-providers: what a status means

Three areas, seventeen routes, and the same lesson finally written down in the code rather
than in this file: **oRPC carries data, so a status only exists once a route puts it there.**

**`headroom.stop` answers 409, and that is not a trend.** Stopping a proxy that was never
running is a state change that did not happen; a 200 would leave the dashboard showing
"stopped" for a proxy it never had. So `stop` returns `{status, ...body}` and the route
lifts that field into the HTTP status. Nothing else in these seventeen does this — every
other refusal is a thrown `AppError` with a `status`. The rule is "a body carries a status
only when the use-case's answer *is* a status", not "bodies may carry statuses".

**`tunnel.tailscaleInstall` splits the decision from the stream.** Installing Tailscale
streams its progress, and a stream is transport. Only the *decision* moved: `prepareInstall`
refuses a request with no password, so the form gets a 400 it can render instead of an event
nobody styled. The SSE stays in the route. This is the same boundary the four `oauth` routes
sit on from the other side.

**Media providers had five copies of one sequence.** `Read the connection → call the
provider → group by language` was identical and drifting across `tts/voices`, `deepgram`,
`elevenlabs`, `inworld` and `minimax`. The *shapes* genuinely differ — each provider names
its id, its languages and its failures differently — so each keeps its own shape function in
`application/tts/tts-voices.ts`; only the sequence was shared.

Three boundary rules in there are silent if broken, so
`tests/unit/tts-voices-boundaries.test.ts` pins them:

- **A missing connection is 400, not 502.** Nothing upstream failed; the caller has not
  connected the provider yet, and the dashboard renders that as an instruction.
- **MiniMax reports failure inside a 200 body.** `base_resp.status_code` is the real verdict;
  checking `res.ok` alone hands the picker an empty list and no reason why.
- **An unknown `?provider=` is 400 with the name in it.** 502 would blame the network for the
  caller's typo.

`?lang=` is applied **before** grouping, deliberately: filtering afterwards advertises
languages whose list is now empty.

Gates this round: `tsc` 0 errors; 10 new tests pass; the failing-test set is identical before
and after the change (447 names, `comm -13` empty) — the suite still carries pre-existing
`vi.*`-under-`bun test` failures, and comparing the *set* is the only honest way to read a
nonzero exit there. Live: all 17 routes answer 401/403 anonymously, none 500.

## usage: three silent rules and one loud one

`usage` is the biggest area left and the one with the most decisions hiding in route bodies.
Twenty-two routes; the twelve panels left were plumbing. Three use-cases carry the rest.

**Quota used is the larger of two numbers.** `usedTokens` on the key row is a committed
counter; the sum over the usage log is what has actually happened. Either can be ahead — the
column lags a write in flight, the log lags a reset. Reading only the column made a spent key
look fresh; reading only the log ignored a reset the column had already applied. The report
takes `max` and the test names both directions, because getting this backwards is invisible:
the page shows a plausible percentage either way.

**The "Deleted keys" row belongs to callers who see every key.** An API-key session is
narrowed to its own key by `visibleKeys`; folding "aggregates with no matching key" into an
orphan row would show that caller another branch's traffic under the label "deleted". The
orphan row is built only when the caller's visible set is the full set.

**A missing query port is a fault, not an empty page.** `usagePanels.errorRows` and
`keyUsage.aggregatesOf` are supplied by the infrastructure factory, so they are optional on the
host contract — and an optional port that silently answers `[]` renders as "no API keys yet"
on an install with plenty. Both use-cases therefore refuse at construction. This is the
`required()` lesson from last round applied where the host, not the factory, is the caller.

**The connection read is the loud one.** Five steps used to be inline: read by id, gate
eligibility, refresh only when OAuth, retry only when a refresh token exists, read an
"expired" answer that arrived as a 200. Reordering is not a cosmetic defect — OpenAI rotates
the refresh token on every refresh, so refreshing from a stale snapshot revokes the session and
signs the operator out. `readConnectionUsage` states the order once and the test asserts the
*sequence* (`["refresh", "usage"]`), not just the end state.

Two statuses are deliberately odd and pinned: "usage not available for this provider" is a
**200 with a message** (the panel renders an explanation, not an error), and a failed refresh
is a **401, not a 500** (the credentials are wrong; the server is fine). The
`refreshAndUpdateCredentials` helper moved out of `[connectionId]/route.ts` into
`lib/usage/connectionRefresh.ts` — `codex-reset-credits` and `claude-reset` both drove that
path, and two copies would drift on the one field that matters.

Gates: `tsc` 0 errors; 11 new tests pass; all 22 routes answer 401/403 anonymously, none 500.

**The leak that looked like a regression.** The before/after failing *sets* differed by 25
names, all in `capabilities-opus-context.test.ts`, resolving 1M Opus models to `222222` — a
number that appears nowhere in that test. It passed alone, in every pair I tried, and in a
clean worktree carrying the same diff. The cause was
`capabilities-memo.test.ts` leaving its fake catalog reader in
`globalThis.__9rCatalogSource`: the last case never reset it, and `refine()` reads that slot.
Its own `beforeEach` protected the next test *in the same file* and nothing else.

Two habits worth keeping from it. A `globalThis` slot outlives the file, so the reset belongs
in `afterEach` as well as `beforeEach`. And when a worktree carrying the identical diff does
*not* reproduce a failure, the difference is state, not code — the bisect should start at what
the suite leaves behind, not at the diff.

Fixing it resolved 240 pre-existing failures: every file that had been inheriting `222222`.

## proxy-pools: wired is not the same as reachable

Nine routes, all already delegating to `getUseCases().proxyPools.*` — and none of them
reachable through oRPC, because `presentation/orpc/routers/` had no file naming a pool. The
routes looked migrated and were not: the migration's unit is the *procedure*, not the
delegation. That distinction is what the next survey should look for.

Found by grouping routes on `getUseCases()` present and `createApiClient` absent: 131 routes
across 24 areas. The plan's guess for this round (`keys`, then `logs`) was wrong on both counts
— `keys` was finished in an earlier pass and `logs` does not exist. The group-by is cheap and
replaces the guess.

Two findings worth carrying:

- `RELAY_PROVIDERS` already models the four deploy routes as one shape (`RELAY_CONTRACTS`), so
  the router exposes a single `deploy` with a validated enum instead of four copies of the same
  handler. A fifth provider now needs one entry, not a fifth route.
- `failed()` sends `{error}` and drops everything else on the error. `PoolInUseError` carries
  `boundConnectionCount` and it never reaches the body. That is unchanged behaviour, so it is
  not a regression — but it is the kind of thing a migration quietly makes permanent, and the
  next person to need that count will look in the use-case first.
