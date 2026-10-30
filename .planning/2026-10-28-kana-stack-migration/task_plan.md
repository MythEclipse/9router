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

**Seventeen of `cli-tools`' twenty-one routes are on oRPC — eighty-four across the migration.**
The sixteen generic `*-settings` routes share one name-keyed registry and four procedures;
`claude` got its own three because it speaks an `env` block rather than a provider entry. Its
port arrives on `context.claudeSettingsHosts`, defaulted in `createApiClient` beside
`cliToolHosts` — the same seam, applied twice, which is now the established shape for host code.

**Next: `codex-profiles` (117) and `cowork-mcp-tools` (111)**, the two largest remaining
handlers in the area that are not blocked. Then `cowork-mcp-registry` (74), `all-statuses` (63),
`hermes-profiles` (17).

Three remain blocked on extraction, in ascending order of work: `devin` (70) does inline
`exec`/`fs` probing with `devinBinCandidates` from the domain; `hermes` (369) has its own
profile helpers in a sibling module; `cowork` (449) is the largest single handler in the area.
Each needs a use-case before a procedure can name it.

`antigravity-mitm` (193 + 42 for `alias`) stays put: it spawns a privileged proxy, installs a
root CA and rewrites the hosts file. Its *decisions* already live in `resolveMitmPassword` and
friends — what remains is process control, which is host work by nature. That is a decision to
record, not a gap to close.

Rule this round added:

- **The same seam, applied twice, is the confirmation that it was the right one.** `claude`'s
  port went onto `RouterContext` with no new thinking required, because `cliToolHosts` had
  already established it. When the second case needs no design, the first design was sound.

**Compare the set of failing test names, never the count.**
