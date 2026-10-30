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

**Twenty-two of `cli-tools`' twenty-six routes are on oRPC.** The area is nearly done; what is
left is three large handlers and one that should not move.

Taken this round, in the order they fell:

- `codex-profiles` (117) — three verbs over `~/.codex/*.config.toml`, behind a four-method port.
- `cowork-mcp-tools` (111) — the probe sequence, with the fetch passed in because the SSRF
  choice needs the request headers.
- `cowork-mcp-registry` (74) — the cursor walk in the use-case, the process-wide cache on the
  host beside `tunnelStatusCache`.
- `all-statuses` (63) — was importing nineteen sibling `GET` handlers as functions; now one
  procedure reusing the same context bundles.
- `devin` (70) — never needed a config port. It has no settings at all, only detection.

**What is left is `hermes` (369) and `cowork` (449)** — the two biggest single handlers in the
area — plus `antigravity-mitm` (193 + 42), which stays by decision: it spawns a privileged proxy,
installs a root CA and rewrites the hosts file. Its *decisions* already live in
`resolveMitmPassword` and friends; what remains is process control, which is host work by nature.

Rules this round added:

- **A test that asserts a status the code cannot return is a test of the test.** Wrapping
  `probeMcpServer` in `try`/`catch` looked right and was dead: the function already catches
  everything and answers 200. The failing assertion was the only thing that ever noticed.
- **When a fixture fails, suspect the fixture before the rule.** Five registry tests failed
  because I invented a flat entry; the real shape is `{ server: { remotes: [{ url }] }, _meta }`.
  The domain validator was right.
- **"Blocked on extraction" is worth re-reading before believing it.** `devin` was on that list
  for three rounds. It was not missing a port — it was missing the recognition that it has
  nothing to write.

**Compare the set of failing test names, never the count.**
