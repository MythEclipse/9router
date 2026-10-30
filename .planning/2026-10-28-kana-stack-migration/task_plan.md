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

Two domain files had no test file of their own. Measuring first — 495 exported names across 84
`domain/` files, 35 of them referenced by none of the 694 test files — turned up a whole file with
zero coverage, not just a function.

### `domain/mimo-login.ts`: 8 exports, nothing testing them

I had declined migrating `oauth/xiaomi-mimo/login/status` earlier on the grounds that it was
"5 branches, all cookie cycle". The function names contradicted that reading: `firstHopRefusal`,
`secondHopRefusal`, `needsEgressProbe`, `redactedEgress`. The file is rule logic, and two of the rules
are security-relevant:

- `redactedEgress` strips `user:pass@` before a proxy URL reaches the log. An unredacted URL in a log
  file is a credential in a log file.
- `mimoLoginStatus` answers `done` only with an identity present. The client persists what it returns
  as a connection, so `done` without one saves a connection that can never authenticate.

25 cases, six mutations, six caught.

### `domain/credential-import.ts`: `jwtPayloadOf` was doing nothing, twice

Writing the test exposed cargo rather than a gap. `jwtPayloadOf` translated `-`→`+`, `_`→`/` and
re-added `=` padding, justified by a comment about `atob` being strict — but the function uses
`Buffer`, and `Buffer`'s decoder accepts the URL-safe alphabet and unpadded input on both Bun and
Node (verified on both runtimes, not assumed). Two surviving mutations proved it: removing the
translation and removing the padding changed nothing.

Both steps are gone, and the runtime contract that made them unnecessary is now pinned by its own
test, so a decoder that stopped accepting base64url would fail loudly instead of silently reducing
every Codex token to "not a JWT" — no email, no workspace, no expiry, no error.

`readLimit` in `cli-tool-settings.ts` is the same shape and still untested; it is next.
