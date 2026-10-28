/**
 * Composition root — the one file that knows every concrete implementation.
 *
 * Wires: env → database → repositories → use-cases → HTTP app. Everything above
 * this line depends on interfaces; everything below it is a detail.
 */
import { randomUUID } from "node:crypto"
import type { Dependencies } from "./application/dependencies.ts"
import { buildUseCases } from "./application/use-cases.ts"
import { createChangelogSourceFromDisk } from "./infrastructure/changelog-source.ts"
import { createDb, resolveDataDir } from "./infrastructure/db/client.ts"
import { runMigrations } from "./infrastructure/db/migrate.ts"
import { createActivityRepository } from "./infrastructure/db/repositories/activity-repository.ts"
import { createApiKeyRepository } from "./infrastructure/db/repositories/api-key-repository.ts"
import { loadEnv } from "./infrastructure/env.ts"
import { createApp } from "./presentation/http/app.ts"

const env = loadEnv()
const dataDir = resolveDataDir(env.DATA_DIR)

const { db, sqlite } = createDb(dataDir)
runMigrations(sqlite, dataDir)

const deps: Dependencies = {
	apiKeys: createApiKeyRepository(db),
	activity: createActivityRepository(db, () => randomUUID()),
	// CHANGELOG.md ships beside the app, not inside the API bundle.
	changelog: createChangelogSourceFromDisk(env.WEB_APP_DIR),
	now: () => new Date(),
	randomId: () => randomUUID(),
}

const useCases = buildUseCases(deps)
const { app } = createApp({ webOrigin: env.WEB_ORIGIN })

// The auth middleware reads `context.session`; until better-auth owns this
// route, every dashboard procedure is correctly rejected with 401.
const server = Bun.serve({
	port: env.PORT,
	hostname: env.HOST,
	fetch(request) {
		// The third argument to `app.fetch` becomes Hono's `env`, and the /api
		// handler reads the app context straight out of it. Wrapping it as
		// `{ context: ... }` type-checks but leaves `context.session` undefined,
		// so every authenticated call silently becomes a 401.
		return app.fetch(request, { session: null, useCases })
	},
})

console.log(`9router-api listening on http://${server.hostname}:${server.port}`)
console.log(`  data dir: ${dataDir}`)
console.log(`  docs:     http://${server.hostname}:${server.port}/api/docs`)

function shutdown(signal: string): void {
	console.log(`${signal} received, closing`)
	server.stop()
	sqlite.close()
	process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
