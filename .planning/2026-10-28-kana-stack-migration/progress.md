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
