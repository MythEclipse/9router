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
	installPxpipeEngine,
	installSemanticCacheModule,
} from "9router-api/infrastructure/use-cases-factory"
import { getSemanticCacheStats, resetSemanticCacheStats } from "open-sse/rtk/semanticCache"
import { createApiKeyStore } from "./apiKeyStore"
import { killAppProcesses } from "./appProcessManager"
import { createComboPresetPort } from "./comboPresetPort"
import {
	catalogueHost,
	knownSttTransport,
	probeBaseUrl,
	registryHost,
	resolveProviderAlias,
	studioCycleRefusal,
} from "./modelRegistryHost"
import { clearPluginCache } from "./plugins/customPluginsRuntime"
import {
	aiProviderEntry,
	armCatalogueSyncer,
	backfillConnectionEmails,
	batchClassifiers,
	clientListingRegistry,
	commandCodeBody,
	connectionHost,
	connectionResponse,
	defaultModelOf,
	fetchCatalogueUrl,
	fetchConnectionModels,
	fetchKiloCatalogue,
	findSyncableCatalogue,
	freeModelCache,
	isSerialProbe,
	normalizeProviderId,
	normalizeProviderSpecificData,
	ollamaLocalHost,
	probeAwsCredentials,
	probeConnection,
	probeModel,
	probeNousKey,
	probeQoderCredentials,
	probeTargetsFor,
	providerAliasOf,
	providerCatalogue,
	providerEntry,
	providerOverrides,
	readSyncedCatalogue,
	refreshSyncedCatalogue,
	sendProbe,
	suggestedCatalogue,
	tokenplanBaseUrl,
	webLogin,
} from "./providerConnectionHost"
import { fetchModels, resolveCustomModels } from "./providerModelsHost"
import { getPxpipeStats, readPxpipeEvents } from "./pxpipe/events"
import { getInstallInfo, getInstallLogTail, installPxpipe } from "./pxpipe/install"
import { loadPxpipe, unloadPxpipe } from "./pxpipe/loader"
import { getPxpipeStatus, runHealthCheck } from "./pxpipe/service"
import { settingsPassword, settingsStore, settingsWriteBack } from "./settingsHost"

// This host is the one that bundles `open-sse` and `lib/pxpipe`, so it is the one
// that can answer those ports. Without this they would report empty results.
installSemanticCacheModule({
	getSemanticCacheStats,
	resetSemanticCacheStats,
})

installPxpipeEngine({
	getPxpipeStatus,
	getInstallInfo,
	installPxpipe,
	loadPxpipe,
	unloadPxpipe,
	runHealthCheck,
	getPxpipeStats,
	readPxpipeEvents,
	getInstallLogTail,
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
			// The settings row is one table: its password hashing, its history and the
			// process state a write owes all live in this process.
			settingsPassword,
			settingsWriteBack,
			settingsStore,
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
			// The model registries and the capability tables live in this
			// directory, so this process is the one that can answer for them.
			registryHost,
			catalogueHost,
			// The connection tables and the provider catalogue live here too.
			connectionHost,
			providerCatalogue,
			connectionResponse,
			normalizeProviderId,
			normalizeProviderSpecificData,
			providerOverrides,
			freeModelCache,
			fetchKiloCatalogue,
			probeTargetsFor,
			providerAliasOf,
			fetchConnectionModels,
			probeModel,
			isSerialProbe,
			batchClassifiers,
			clientListingRegistry,
			probeConnection,
			backfillConnectionEmails,
			fetchModels,
			resolveCustomModels,
			suggestedCatalogue,
			findSyncableCatalogue,
			readSyncedCatalogue,
			refreshSyncedCatalogue,
			fetchCatalogueUrl,
			armCatalogueSyncer,
			sendProbe,
			defaultModelOf,
			providerEntry,
			aiProviderEntry,
			probeAwsCredentials,
			probeQoderCredentials,
			probeNousKey,
			ollamaLocalHost,
			tokenplanBaseUrl,
			commandCodeBody,
			webLogin,
			findStudioCycle: studioCycleRefusal,
			resolveProviderAlias,
			knownSttTransport,
			probeBaseUrl,
		})
		scope[CACHE_KEY] = { useCases }
	}
	return scope[CACHE_KEY]
}

export function getUseCases(): UseCases {
	return cache().useCases
}
