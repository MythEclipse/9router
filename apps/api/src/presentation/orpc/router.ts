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
import { dashboardKeysRouter } from "./routers/dashboard-keys.ts"
import { errorLogsRouter } from "./routers/error-logs.ts"
import { pricingRouter } from "./routers/pricing.ts"
import { settingsRouter } from "./routers/settings.ts"
import { systemRouter } from "./routers/system.ts"
import { cacheStatsRouter, dashboardJobsRouter, pluginsRouter } from "./routers/system-runtime.ts"
import { themeRouter } from "./routers/theme.ts"
import { usageRouter } from "./routers/usage.ts"

export const appRouter = base.router({
	system: systemRouter,
	settings: settingsRouter,
	apiKeys: apiKeysRouter,
	dashboardKeys: dashboardKeysRouter,
	combos: combosRouter,
	errorLogs: errorLogsRouter,
	theme: themeRouter,
	pricing: pricingRouter,
	usage: usageRouter,
	plugins: pluginsRouter,
	cacheStats: cacheStatsRouter,
	dashboardJobs: dashboardJobsRouter,
})

export type AppRouter = typeof appRouter
