/**
 * Serving entry point.
 *
 * The use-case graph comes from `apps/web/src/lib/useCases.ts`, not from a second
 * wiring written here. That module already supplies every port `createUseCases`
 * requires — tunnels, OAuth sessions, relay deploys, the job runner, the model
 * catalogue — because the dashboard needs all of them. Rebuilding that list here
 * would mean either importing the same modules anyway or substituting refusals for
 * working ones, and a server whose catalogue is empty and whose tunnels refuse is a
 * server that answers 200 with nothing behind it.
 *
 * One thing does not resolve outside Next: `server-only`. It is a marker package
 * Next supplies during its own build, so nothing on disk provides it. `bunfig.toml`
 * maps it at runtime and `scripts/build.ts` maps it for the bundle; both point at
 * `@9router/db/serverOnly`, the empty server branch of that marker.
 *
 * The session is resolved per request from the `auth_token` cookie rather than held
 * in a better-auth store. The dashboard logs users in through `apps/web`, which
 * signs a JWT; this process verifies that same JWT with the secret both share.
 * Anything stateful here would be invisible to the process that sets the cookie, and
 * every dashboard call would be a 401.
 */

import { getDataDir } from "@9router/db/shared/dataDir"
import { jwtVerify } from "jose"
import { getUseCases } from "../../web/src/lib/useCases.ts"
import { loadEnv } from "./infrastructure/env.ts"
import { loadJwtSecret } from "./infrastructure/jwt-secret.ts"
import { resolveSession } from "./infrastructure/session-from-cookie.ts"
import { createApp } from "./presentation/http/app.ts"

const env = loadEnv()

// `apps/web` resolves the migration journal from its own cwd, which is `apps/web`
// under Next and the repo root when this file is the entry point. Setting it here,
// before the graph is built, keeps both processes on one schema without asking the
// operator to start the server from a particular directory.
process.env.MIGRATIONS_DIR ??= new URL("../migrations", import.meta.url).pathname

const useCases = getUseCases()

// `env.DATA_DIR` is optional, and `process.cwd()` is the wrong fallback: run from
// `apps/api`, the process would generate a *second* signing key in that directory
// and reject every cookie `apps/web` signed. `getDataDir()` is the same
// `DATA_DIR`-else-`~/.9router` rule the database and the dashboard already use, so
// all three processes read one key.
const dataDir = env.DATA_DIR ?? getDataDir()
const jwtSecret = loadJwtSecret(dataDir)

const { app } = createApp({ webOrigin: env.WEB_ORIGIN })

const server = Bun.serve({
	port: env.PORT,
	hostname: env.HOST,
	async fetch(request) {
		// Resolved here, once, so no procedure has to know how a session is
		// obtained. A bad cookie is `null`, and `authed` turns that into a 401.
		const session = await resolveSession(request.headers.get("cookie"), jwtSecret, jwtVerify)
		// The third argument to `app.fetch` becomes Hono's `env`, and the /api
		// handler reads the app context straight out of it. Wrapping it as
		// `{ context: ... }` type-checks but leaves `context.session` undefined,
		// so every authenticated call silently becomes a 401.
		return app.fetch(request, { session, useCases, headers: request.headers })
	},
})

console.log(`9router-api listening on http://${server.hostname}:${server.port}`)
console.log(`  docs:     http://${server.hostname}:${server.port}/api/docs`)

function shutdown(signal: string): void {
	console.log(`${signal} received, closing`)
	server.stop()
	process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
