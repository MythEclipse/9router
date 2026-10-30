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

Three loose ends, all being closed now.

**1. The packaged tree was never compared with the tree that was built.** `copy-standalone-assets.mjs`
and `build-cli.ts` both copy `src/`, `scripts/`, `open-sse/` and `migrations/` **as source**. A green
`bun run build` therefore proves the compiler ran, not that the bytes on disk are those bytes. It has
already shipped stale code once — `cli/moon.yml` records `auth-guard-hooks.mjs` "silently never shipped".
`tests/unit/standalone-package-matches-source.test.ts` now hashes every copied file against its source
and asserts the runtime assets (migrations, the bundled `mitm/server.js`, the guard beside its aliases).
Skipped, not failed, when a tree has not been built.

**2. `cli/app` on disk was from another commit** — dated 28 October against `apps/web` at 30 October,
51 files absent (32 under `lib/`, 17 under `mitm/`) and 193 whose length a path rewrite cannot explain.
`apiKeyStore.ts`, `cliToolHosts.ts` and `response.ts` were all created on 29–30 October, after the copy.
The test caught this; the fix is to rebuild the tree, not to soften the assertion.

A correction worth keeping: the first version of that test compared `cli/app` byte-for-byte and reported
211 stale files. It was wrong. `cli/app` is a Next standalone tree whose `jsconfig.json` maps only `@/*`
and `open-sse/*`; there is no `@9router/*` beside it, so the packager rewrites `@9router/db/repos/x` to
`@/lib/db/repos/x`. A difference in an import specifier is expected. **"Different" is not "stale"** — the
honest question is whether the difference is one the build is supposed to introduce.

**3. The ledger claimed `apps/web` had no oRPC client.** It does: `orpcClient.ts` via
`createRouterClient`, 125 of 199 routes. Corrected, along with a map of the remaining 74 and the two
that must never migrate (`pxpipe/install` and `pxpipe/start` would let an API key install software).

Then push: 118 commits are ahead of `origin/migrate/kana-stack`.
