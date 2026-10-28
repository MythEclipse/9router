/**
 * Router index.
 *
 * `os.router()` returns a plain object with no `.use()` method, so every
 * procedure applies its own middleware via `base`/`authed`. This file only
 * namespaces the routers.
 *
 * `router` is called on `base` rather than bare `os`: the router must carry the
 * AppContext type, and a context-free `os.router()` rejects every procedure
 * built with `$context<AppContext>()` ("index signature for type 'string' is
 * missing").
 */
import { base } from "./base.ts"
import { apiKeysRouter } from "./routers/api-keys.ts"
import { combosRouter } from "./routers/combos.ts"
import { errorLogsRouter } from "./routers/error-logs.ts"
import { settingsRouter } from "./routers/settings.ts"
import { systemRouter } from "./routers/system.ts"

export const appRouter = base.router({
	system: systemRouter,
	settings: settingsRouter,
	apiKeys: apiKeysRouter,
	combos: combosRouter,
	errorLogs: errorLogsRouter,
})

export type AppRouter = typeof appRouter
