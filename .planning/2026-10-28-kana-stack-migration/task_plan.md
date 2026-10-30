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

Measuring coverage beat reading code for the third time this session, and turned up a live defect
rather than only missing tests.

### `readLimit` wrote a one-token context window

`Number()` alone accepts `true` as 1 and `[5]` as 5, so a settings write carrying
`contextWindow: true` stored a model whose window is one token. Fixed and committed with eleven
mutations caught.

### `asKeyPermissions` was the untested entrance to the permission chain

29 tests covered every other export of `sub-key-scope.ts`. The one that feeds them — reached from
`callerFromSession`, read by `mayCreateSubKey` — was unasserted, including its only defence: `=== true`,
which is what refuses a session carrying `manageApiKeys: "true"`. Eight cases added, five mutations
caught.

### Where the sweep stands

22 of 495 domain functions are still unreferenced by any of the 697 test files, down from 35. Most are
covered through a sibling that is tested (`findChainTo` inside `findComboCycle`,
`validateMicrosoftTokenEndpoint` in `kiro-external-idp.test.ts`, `validateEndpointKinds` in
`key-ownership-and-update.test.ts`). The remainder are catalogue and formatting helpers —
`languageBucket`, `timedOutAnswer`, `anthropicCompatibleVerdict` — where a test would compare a table
to itself.

The next honest step is not more of the same: it is to decide whether the 22 are genuinely
covered-through-a-sibling by checking that the sibling's assertions reach the behaviour, which is a
different question from whether the name appears in a test file.
