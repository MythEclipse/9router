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

Merged to `master` at `390cafb3a` (v5.0.0), branch `migrate/kana-stack` deleted locally and on the
remote. `master` was 0 commits ahead, so the merge was a fast-forward with no conflicts. Tree is
`master`, 0/0 against `origin/master`, typecheck 0 errors, 8152 tests passing, `bun run build` green.

The three loose ends are closed:

**Packaged tree vs built tree.** `tests/unit/standalone-package-matches-source.test.ts` hashes every
copied file in `.next/standalone` against its source and asserts the runtime assets a build can drop
(migrations, the bundled `mitm/server.js`, the guard beside its `open-sse/` aliases). Five mutations,
all killed. The `cli/app` half asserts what its launcher touches instead — writing it took four wrong
assumptions, all recorded in the file, because the tree is compiled rather than read.

**Ledger corrected.** The claim that `apps/web` had no oRPC client was stale; `orpcClient.ts` exists and
125 of 199 routes use it. The remaining 74 are mapped by reason, including the two that must never
migrate (`pxpipe/install`, `pxpipe/start` — an API key that can install is a key that can change what
runs on the host).

**Push done.** 120 commits plus the bump.

What is left is not migration work. The transport question is settled and documented; the domain rules
live where tests can reach them, which was the point of the whole sweep. The honest remaining items are
things nobody has asked for yet: the 21 routes still calling `getUseCases()` directly (each needs the
"is the router a place this route may be reachable from" check before moving), and the `open-sse`
translation layer's known bugs, which `tests/translator/AGENTS.md` already tracks as `it.fails` cases
with file:line references.
