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

The route sweep is done for the routes that can hide a decision. Of 199 handlers, 120 are never named
by a test; 94 delegate to tested use-cases, 22 import their rules from `9router-api/domain`, and the
`antigravity-mitm` route that looked worst by branch count (21) turned out to be pure wiring. Counting
`if`s measures nothing — the question is whether the decision lives in the route.

Four routes held real logic. Three were already careful (`v1/api/chat` delegates to `handleChat`;
`console-logs/stream` has an idempotent `cleanup` with a comment about the listener leak it fixes;
`headroom/proxy` refuses non-http schemes and strips hop-by-hop headers). The fourth was a defect:

    /api/usage/stream?period=abc  →  200 text/event-stream, the entire history

`periodCutoff` in `packages/db` maps an unknown period to `null`, and `null` means unbounded. The other
six usage routes refuse it through `isReportingPeriod`; `usage/leaderboard` even documents fixing this
exact bug. The SSE route was the one never covered, and the one where it is silent. Fixed with the
shared rule, refused before the stream opens. Five cases, four mutations, all killed.

**The instrument lied twice, both times in the convenient direction.** `bun run test` exits 0 even when
vitest fails, so a harness keyed to the exit code reported three guards as surviving when they had in
fact failed with the assertion that proves them. Parse `Tests  N failed | M passed`, and treat `M == 0`
as a failed load, never a pass. Same shape as the injection lesson from the domain sweep.

**Also recorded, and benign:** `cli/app` looks like a second 199-route tree but is ignored build output
from `build-cli.ts`, dated a day behind `apps/web`. `bun run build` does not touch it. The proxy's
`LOOPBACK_HOSTS` is stricter than `detect.ts`, not looser: `URL` normalises `127.1` to `127.0.0.1`, and
`0.0.0.0` gets its credentials stripped.

Next: the build itself — the one surface no unit test can reach. `bun run build` is green, but nothing
checks that the standalone payload serves the same routes the source does. The `cli/app` staleness
already shipped a fix that never arrived once; a check that the packaged tree matches the built source
would catch that class before it recurs.
