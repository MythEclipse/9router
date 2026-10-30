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
import { cliToolsRouter } from "./routers/cli-tools.ts"
import { combosRouter } from "./routers/combos.ts"
import { dashboardKeysRouter } from "./routers/dashboard-keys.ts"
import { errorLogsRouter } from "./routers/error-logs.ts"
import { headroomRouter } from "./routers/headroom.ts"
import { mediaProvidersRouter } from "./routers/media-providers.ts"
import { modelsRouter } from "./routers/models.ts"
import { oauthRouter } from "./routers/oauth.ts"
import { pricingRouter } from "./routers/pricing.ts"
import { providersRouter } from "./routers/providers.ts"
import { proxyPoolsRouter } from "./routers/proxy-pools.ts"
import { pxpipeRouter } from "./routers/pxpipe.ts"
import { settingsRouter } from "./routers/settings.ts"
import { systemRouter } from "./routers/system.ts"
import { cacheStatsRouter, dashboardJobsRouter, pluginsRouter } from "./routers/system-runtime.ts"
import { themeRouter } from "./routers/theme.ts"
import { tunnelRouter } from "./routers/tunnel.ts"
import { usageRouter } from "./routers/usage.ts"

export const appRouter = base.router({
	system: systemRouter,
	settings: settingsRouter,
	apiKeys: apiKeysRouter,
	dashboardKeys: dashboardKeysRouter,
	cliTools: cliToolsRouter,
	combos: combosRouter,
	errorLogs: errorLogsRouter,
	theme: themeRouter,
	pricing: pricingRouter,
	usage: usageRouter,
	plugins: pluginsRouter,
	cacheStats: cacheStatsRouter,
	dashboardJobs: dashboardJobsRouter,
	pxpipe: pxpipeRouter,
	models: modelsRouter,
	providers: providersRouter,
	proxyPools: proxyPoolsRouter,
	oauth: oauthRouter,
	tunnel: tunnelRouter,
	headroom: headroomRouter,
	mediaProviders: mediaProvidersRouter,
})

export type AppRouter = typeof appRouter
