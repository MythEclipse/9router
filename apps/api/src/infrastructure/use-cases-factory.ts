/**
 * Use-case factory shared by both entry points.
 *
 * `apps/api` runs the oRPC server; `apps/web` still serves the Next routes. Both
 * must build the *same* use-cases over the *same* database, otherwise the rules
 * live twice — which is the drift this migration exists to remove.
 *
 * So this is the one place that knows the concrete adapters. Each entry point
 * calls it once and holds the result; neither constructs a use-case itself.
 */

import { randomUUID } from "node:crypto"
import type { ComboPresetPort } from "../application/dependencies.ts"
import { buildUseCases, type UseCases } from "../application/use-cases.ts"
import { createChangelogSourceFromDisk } from "./changelog-source.ts"
import { createComboRotationPort } from "./combo-rotation-port.ts"
import { createDb, resolveDataDir } from "./db/client.ts"
import { runMigrations } from "./db/migrate.ts"
import { createActivityRepository } from "./db/repositories/activity-repository.ts"
import { createApiKeyRepository } from "./db/repositories/api-key-repository.ts"
import {
	createComboRepository,
	createStudioTargetRepository,
} from "./db/repositories/combo-repository.ts"
import { createComboStrategyRepository } from "./db/repositories/combo-strategy-repository.ts"
import { createSettingsPort } from "./settings-port.ts"
import { createUnavailablePresetPort } from "./unavailable-preset-port.ts"

export interface UseCaseOptions {
	/** Overrides `DATA_DIR`; the gateway and the API must agree on this. */
	readonly dataDir?: string
	/** Where `apps/web` lives, for reading its CHANGELOG.md. */
	readonly webAppDir?: string
	/** Gateway that owns combo rotation state; absent means "nothing to notify". */
	readonly gatewayUrl?: string
	readonly onRotationError?: (error: unknown) => void
	/**
	 * Journal directory, for a host whose bundler rewrote `import.meta.url`
	 * (Turbopack does). Omitted means "locate it from this module".
	 */
	readonly migrationsDir?: string
	/** Supplied by the host that owns the client catalogs (`apps/web`). */
	readonly comboPresets: ComboPresetPort
}

export interface UseCasesHandle {
	readonly useCases: UseCases
	/** Released by the owning process on shutdown. */
	close(): void
}

export function createUseCases(
	options: UseCaseOptions = { comboPresets: createUnavailablePresetPort() },
): UseCasesHandle {
	const dataDir = resolveDataDir(options.dataDir ?? process.env.DATA_DIR)
	const { db, sqlite } = createDb(dataDir)
	runMigrations(sqlite, dataDir, { migrationsDir: options.migrationsDir })

	const useCases = buildUseCases({
		apiKeys: createApiKeyRepository(db),
		activity: createActivityRepository(db, () => randomUUID()),
		changelog: createChangelogSourceFromDisk(options.webAppDir ?? "apps/web"),
		settings: createSettingsPort(),
		combos: createComboRepository(),
		studios: createStudioTargetRepository(),
		comboPresets: options.comboPresets,
		comboStrategies: createComboStrategyRepository(),
		comboRotation: createComboRotationPort({
			gatewayUrl: options.gatewayUrl,
			onError: options.onRotationError,
		}),
		now: () => new Date(),
		randomId: () => randomUUID(),
	})

	return { useCases, close: () => sqlite.close() }
}
