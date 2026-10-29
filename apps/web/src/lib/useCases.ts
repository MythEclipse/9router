/**
 * The process-wide use-case graph.
 *
 * Built once, on first use. Constructing it opens the SQLite handle and runs
 * migrations, so doing it at module import would run migrations during a Next
 * build. Next reloads route modules per request in development, so the instance
 * is cached on `globalThis` — a module-level variable would open a new database
 * handle on every hot reload until the process ran out of file descriptors.
 */

import { join } from "node:path"
import { closeDb } from "@9router/db/driver"
import type { UseCases } from "9router-api/application/use-cases"
import {
	createUseCases,
	installSemanticCacheModule,
} from "9router-api/infrastructure/use-cases-factory"
import { getSemanticCacheStats, resetSemanticCacheStats } from "open-sse/rtk/semanticCache"
import { createApiKeyStore } from "./apiKeyStore"
import { killAppProcesses } from "./appProcessManager"
import { createComboPresetPort } from "./comboPresetPort"
import { clearPluginCache } from "./plugins/customPluginsRuntime"

// This host is the one that bundles `open-sse`, so it is the one that can answer
// the cache counters. Without this the port would report zeros forever.
installSemanticCacheModule({
	getSemanticCacheStats,
	resetSemanticCacheStats,
})

const CACHE_KEY = Symbol.for("9router.useCases")

interface Cache {
	readonly useCases: UseCases
}

function cache(): Cache {
	const scope = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache }
	if (!scope[CACHE_KEY]) {
		const { useCases } = createUseCases({
			dataDir: process.env.DATA_DIR,
			webAppDir: process.cwd(),
			gatewayUrl: process.env.GATEWAY_URL,
			onRotationError: (error) => console.warn("combo rotation reset failed:", error),
			comboPresets: createComboPresetPort(),
			apiKeyStore: createApiKeyStore(),
			// The dashboard is the process that holds the plugin runtime, so it is
			// the one that can invalidate the cached configuration.
			pluginCache: { clear: clearPluginCache },
			// ...and the one that owns the managed background processes, so shutdown
			// stops them here rather than leaving orphans behind.
			stopManagedProcesses: killAppProcesses,
			// The dashboard's database is the shared driver, not the handle the
			// factory opened, so it is closed through the driver's own entry point.
			closeDatabase: closeDb,
			// Turbopack rewrites import.meta.url, so the migrator cannot find the
			// journal on its own here. copy-standalone-assets.mjs stages it at
			// <server cwd>/migrations.
			migrationsDir: join(process.cwd(), "migrations"),
		})
		scope[CACHE_KEY] = { useCases }
	}
	return scope[CACHE_KEY]
}

export function getUseCases(): UseCases {
	return cache().useCases
}
