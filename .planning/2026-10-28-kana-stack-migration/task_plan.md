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

**`proxy-pools` is on oRPC — 9 routes, sixty-four across the migration.** The area was already
delegating to `getUseCases().proxyPools.*` in-process, but no procedure named a pool, so a
caller outside this Next.js app had no way in. That is the distinction the next areas hinge on:
*wired to a use-case* is not the same as *reachable through oRPC*.

The survey that found it is worth repeating before the next pick. Group the routes by whether
they call `getUseCases()` but never `createApiClient` — 131 do, across 24 areas. `keys` was
already finished when this round's plan named it; `logs` does not exist. The list is the point,
not the plan's guess.

- **`cli-tools` (17 routes, ~1900 lines) is next**, and it is not uniform: `cowork-settings`
  (449) and `hermes-settings` (369) carry real decisions, the fourteen `*-settings` routes are
  thin `port + installed` shims, and `antigravity-mitm` legitimately stays where it is because
  it spawns a privileged proxy. Read before splitting, and expect two commits: the use-cases
  that are missing, then the procedures over the ones that exist.
- After that: `proxy-pools` siblings `provider-nodes` (3) and `combos` (4).

Two rules this round added:

- **A status carried in the domain is only a status once the table says so.** `PoolInUseError`
  sets `code: "CONFLICT"`; that is a 409 solely because `STATUS_BY_CODE` maps it. The refusal
  itself tests green either way, so the mapping needs its own assertion.
- **`failed()` sends `{error}` and nothing else.** `boundConnectionCount` is on the error object
  and is dropped at the boundary — preserved behaviour, but the next person who needs that
  count in the body will find it missing and blame the use-case.

**Compare the set of failing test names, never the count.** The suite carries pre-existing
failures in files that only fail under full-suite load.
