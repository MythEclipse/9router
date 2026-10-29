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

**`usage` is on oRPC — 22 routes, fifty-five across the migration so far.** Three use-cases
carry it: `keyUsage` (per-key aggregates and quota), `usagePanels` (errors, leaderboard,
providers, token savings, available models, request details) and `connectionUsage` (the ordered
provider read). The routes that remain carry a query string and a status.

The two lessons this round added, both from rules that fail *quietly*:

- **An optional port on the host contract must refuse, not answer empty.** `aggregatesOf`,
  `errorRows` and `leaderboardRows` are filled by the infrastructure factory, so they are
  optional where the host is the caller — and an optional port that returns `[]` renders as
  "no API keys yet" on an install with plenty. `required()` in the factory proves nothing about
  who supplies the value at the other end. Both use-cases throw at construction instead.
- **A leaked global reads as a flake and costs a bisect.** A test that installs a capability
  catalog must reset it in `afterEach`, not only `beforeEach`: the next file inherits it, and
  the failure surfaces in tests that are unrelated to the change being made. This round spent a
  worktree bisect on exactly that before finding `capabilities-memo.test.ts`. When the
  before/after failing *sets* differ, bisect the file that leaves global state, not the diff.

**Next area: `keys` (remaining), then `logs`.** Pick by the same survey: which handlers still
*decide* something rather than delegate. Compare the *set* of failing test names, never the
bare count — the suite carries pre-existing failures in files that only fail under full-suite
load, and a count reads those as progress.
