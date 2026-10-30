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

**`cli-tools` is partly on oRPC — 16 of 20 settings routes, eighty across the migration.** The
fourteen near-identical `*-settings` handlers collapsed into one name-keyed registry
(`apps/web/src/lib/cliToolRegistry.ts`) plus four procedures. Three commit boundaries, because
each is reviewable on its own: the registry, the router, the route delegation.

The finding worth keeping is a layering one. My first router imported the registry from
`apps/web` and it broke the build: **`apps/api` never depends on `apps/web`** — the arrow runs
the other way, and a bundle of `isInstalled`/config-port/side-write functions is exactly the
kind of host code that must not move inward. The resolver therefore arrives on
`RouterContext.cliToolHosts`, defaulted inside `createApiClient`, which is the same seam
`useCases` and `headers` already use. Reach for the context before reaching for an import
across packages.

Also: **verify transcriptions against the source, not against memory.** The `smelt` reset
message came out as "9Router removed from Smelt" where the route said "Smelt 9Router settings
removed". No type checks it and no existing test asserts it — it was caught by diffing all 48
messages back against `git show HEAD:<route>`, and that diff is now why the registry test checks
the shape of every entry.

**Still in `cli-tools`:** `devin` (70), `hermes` (369) and `cowork` (449) have no
`ToolConfigPort` and do their own filesystem work, so they need use-case extraction before a
procedure can name them. `claude` (33) has its own use-case and is a small addition. Then
`antigravity-mitm` (193+42) stays put and that should be written down as a decision, not a gap.
Also outstanding in the area: `all-statuses` (63), `codex-profiles` (117),
`cowork-mcp-registry` (74), `cowork-mcp-tools` (111), `hermes-profiles` (17).

Rule this round added:

- **A cross-package import is usually a missing injection point.** When the only way to reach
  something is `../../../../other-package/...`, the dependency graph is telling you the value
  belongs on the context.

**Compare the set of failing test names, never the count.**
