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

The domain-coverage sweep is finished for everything that matters, and the measurement itself had to
be corrected twice before its output could be trusted.

**What is covered now.** 495 exported domain functions; the three that no test executed *and* that
select a branch — `isReportingPeriod`, `isMitmToolAction`, `tooLarge` — have ten cases. `timedOutAnswer`
was adopted by its only intended caller and two defects fell out of that. Along the way `readLimit`
turned out to coerce a boolean into a one-token context window, and `jwtPayloadOf` was carrying two
no-op steps behind a comment.

**What the remaining 19 are.** Twelve are executed through a sibling (measured, not assumed), and the
rest are path helpers and formatting functions reached by tests that do not name them.

**The lesson worth keeping.** Sabotage is a better instrument than a coverage report here, because the
report cannot see outside `root: tests` and the injection answers the actual question — is this code
ever run. But sabotage is only trustworthy when each injection is verified to load: a one-line edit to
a two-line arrow declaration broke `errors.ts` and made 30+ files fail collection, which I briefly read
as "not executed". One function per run; a run with `Failed Suites > 0` is discarded.

Next: leave the domain alone and go where the tests cannot reach by construction — the route handlers
that were declined during migration (52, of which 25 are gateway `v1`/`v1beta`), and the build itself.
