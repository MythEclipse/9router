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

The coverage question is answered, and it was measurable without coverage tooling.

**The method.** `@vitest/coverage-v8` reported only files under `tests/` because the suite runs with
`root: tests`, and a wider root broke `setupFiles`; two config attempts were dropped rather than
fought. Instead: inject a labelled `throw` into every domain function no test names, run the suite
once, count the labels. 21 of 22 injected, and the result splits cleanly — 12 are reached through a
sibling even though their names appear nowhere in the test tree, 9 are never executed.

**The defect.** `timedOutAnswer` was the one of those nine with no consumer at all. It was written for
the ceiling branch in `suggest-models`, and `withTimeout` had inlined its own copy that omitted
`message` — which the route forwards as the client's `error`, so a stalled catalogue reached the panel
looking like an empty provider. The same lines also let a late fetch call `refreshSynced` after the
request had been answered, because `Promise.race` cannot cancel the loser. Both fixed, four cases
added, three mutations caught.

**Where this leaves the sweep.** 22 of 495 domain functions are unnamed in the test tree; 13 of those
are executed by tests anyway; 9 are executed by no test, of which 8 have real callers whose own tests
do not reach them. Those eight are the honest remaining gap — `isReportingPeriod`, `isMitmToolAction`,
`tooLarge`, `hermesRoot`, `auxRoleArE`, `profilesRoot`, `removeDelegationBlock`, `isPeriodRefused` —
each a one-line predicate or path helper whose failure mode is a wrong branch, not a crash.

Next: write those eight directly. Not because coverage matters as a number, but because a one-line
predicate that no test executes is a branch nothing has ever gone down.
