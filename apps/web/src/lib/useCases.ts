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
import type { UseCases } from "9router-api/application/use-cases"
import { createUseCases } from "9router-api/infrastructure/use-cases-factory"
import { createComboPresetPort } from "./comboPresetPort"

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
