/**
 * Serving entry point.
 *
 * Wiring lives in `infrastructure/use-cases-factory.ts` so that `apps/web` can
 * build the same use-cases over the same database; this file only listens.
 */
import { loadEnv } from "./infrastructure/env.ts"
import { createUnavailablePresetPort } from "./infrastructure/unavailable-preset-port.ts"
import { createUseCases } from "./infrastructure/use-cases-factory.ts"
import { createApp } from "./presentation/http/app.ts"

const env = loadEnv()

const { useCases, close } = createUseCases({
	dataDir: env.DATA_DIR,
	webAppDir: env.WEB_APP_DIR,
	gatewayUrl: env.GATEWAY_URL,
	// A failed fan-out is not worth failing the request, but it must not be
	// invisible either: the next request would resume a stale rotation.
	onRotationError: (error) => console.warn("combo rotation reset failed:", error),
	comboPresets: createUnavailablePresetPort(),
})

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
console.log(`  docs:     http://${server.hostname}:${server.port}/api/docs`)

function shutdown(signal: string): void {
	console.log(`${signal} received, closing`)
	server.stop()
	close()
	process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
