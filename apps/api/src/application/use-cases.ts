/**
 * Composition of every use-case over one `Dependencies` graph.
 *
 * The single place that knows which use-case exists. Routers receive this
 * object, never the database, so wiring stays centralised and a test can build
 * the same shape from fakes.
 */

import { makeBulkEditApiKeys } from "./api-keys/bulk-edit-api-keys.ts"
import { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
import { makeManageApiKeys } from "./api-keys/manage-api-keys-dashboard.ts"
import { makeManageSingleKey } from "./api-keys/manage-single-key.ts"
import { loadChangelog } from "./changelog.ts"
import {
	makeCheckComboCycle,
	makeCreateCombo,
	makeCreateComboPresets,
	makeDeleteCombo,
	makeDuplicateCombo,
	makeGetCombo,
	makeListCombos,
	makePreviewComboPresets,
	makeUpdateCombo,
} from "./combos/manage-combos.ts"
import type { Dependencies } from "./dependencies.ts"
import { makeClearErrorLogs, makeListErrorLogs } from "./error-logs/read-error-logs.ts"
import { makeModelCatalogue } from "./models/list-models.ts"
import { makeCustomModels, makeModelAliases } from "./models/manage-aliases.ts"
import { makeModelAvailability } from "./models/manage-availability.ts"
import { makeCatalogueSync, makeModelProbe } from "./models/manage-catalogue-sync.ts"
import { makeBaseUrlValidation, makeDisabledModels } from "./models/manage-disabled-models.ts"
import { makeProviderNodes } from "./models/manage-provider-nodes.ts"
import { makeStudioModels } from "./models/manage-studio-models.ts"
import { makeReadPlugins, makeWritePlugins } from "./plugins/manage-plugins.ts"
import { makeGetPricing, makeResetPricing, makeUpdatePricing } from "./pricing/manage-pricing.ts"
import { makeCheckConnection } from "./providers/check-connection.ts"
import { makeListClientConnections } from "./providers/list-client-connections.ts"
import { makeFreeModels } from "./providers/list-free-models.ts"
import { makeListProviderModels } from "./providers/list-provider-models.ts"
import { makeConnections } from "./providers/manage-connections.ts"
import { makeOverrides } from "./providers/manage-overrides.ts"
import { makeProbeModels } from "./providers/probe-models.ts"
import { makeSuggestModels } from "./providers/suggest-models.ts"
import { makeTestConnections } from "./providers/test-connections.ts"
import { makeValidateCredential } from "./providers/validate-credential.ts"
import { makeWebLogin } from "./providers/web-login.ts"
import { makePxpipe } from "./pxpipe/manage-pxpipe.ts"
import { assertSupportedLocale } from "./settings/locale.ts"
import { readLoginGate } from "./settings/login-gate.ts"
import { makeManageSettings } from "./settings/manage-settings.ts"
import { makeSettingsHistory } from "./settings/settings-history.ts"
import { makeGetTheme, makeSetTheme } from "./settings/theme.ts"
import { makeCacheStats } from "./system/cache-stats.ts"
import { makeDashboardJobs } from "./system/dashboard-jobs.ts"
import { makeShutdownFromDashboard, makeShutdownFromHook } from "./system/shutdown.ts"
import { makeUsageReports } from "./usage/report-usage.ts"

export interface UseCases {
	readonly createApiKey: ReturnType<typeof makeCreateApiKey>
	readonly listApiKeys: ReturnType<typeof makeListApiKeys>
	readonly revokeApiKey: ReturnType<typeof makeRevokeApiKey>
	/** The dashboard's key table: list, create with scoping, bulk edit. */
	readonly dashboardKeys: ReturnType<typeof makeManageApiKeys>
	readonly bulkEditKeys: ReturnType<typeof makeBulkEditApiKeys>
	readonly singleKey: ReturnType<typeof makeManageSingleKey>
	/** The read-only usage endpoints: stats, chart, sparks, logs, history. */
	readonly usageReports: ReturnType<typeof makeUsageReports>
	readonly getChangelog: () => ReturnType<typeof loadChangelog>
	readonly getLoginGate: () => ReturnType<typeof readLoginGate>
	readonly listCombos: ReturnType<typeof makeListCombos>
	readonly createCombo: ReturnType<typeof makeCreateCombo>
	readonly getCombo: ReturnType<typeof makeGetCombo>
	readonly updateCombo: ReturnType<typeof makeUpdateCombo>
	readonly deleteCombo: ReturnType<typeof makeDeleteCombo>
	readonly duplicateCombo: ReturnType<typeof makeDuplicateCombo>
	readonly checkComboCycle: ReturnType<typeof makeCheckComboCycle>
	readonly previewComboPresets: ReturnType<typeof makePreviewComboPresets>
	readonly createComboPresets: ReturnType<typeof makeCreateComboPresets>
	readonly listErrorLogs: ReturnType<typeof makeListErrorLogs>
	readonly clearErrorLogs: ReturnType<typeof makeClearErrorLogs>
	readonly settings: ReturnType<typeof makeManageSettings>
	readonly settingsHistory: ReturnType<typeof makeSettingsHistory>
	readonly getTheme: ReturnType<typeof makeGetTheme>
	readonly setTheme: ReturnType<typeof makeSetTheme>
	/**
	 * Rejects an unsupported locale with VALIDATION. The supported list comes
	 * from the caller because the dashboard owns the translations.
	 */
	readonly assertLocale: (requested: unknown, supported: readonly string[]) => string
	readonly getPricing: ReturnType<typeof makeGetPricing>
	readonly updatePricing: ReturnType<typeof makeUpdatePricing>
	readonly resetPricing: ReturnType<typeof makeResetPricing>
	/** The custom-plugin settings, as one shape for both read and write. */
	readonly readPlugins: ReturnType<typeof makeReadPlugins>
	readonly writePlugins: ReturnType<typeof makeWritePlugins>
	/** Response-cache counters; `reset` answers with the zeroed snapshot. */
	readonly cacheStats: ReturnType<typeof makeCacheStats>
	/** Server-side dashboard operations: start, poll, live, cancel. */
	readonly dashboardJobs: ReturnType<typeof makeDashboardJobs>
	/** Two identities, one shutdown sequence. */
	readonly shutdownFromDashboard: ReturnType<typeof makeShutdownFromDashboard>
	readonly shutdownFromHook: ReturnType<typeof makeShutdownFromHook>
	/** The pxpipe controls: status, start, stop, reload, install, health, stats, logs. */
	readonly pxpipe: ReturnType<typeof makePxpipe>
	/** Aliases and custom models, which share the key reconcile step. */
	readonly modelAliases: ReturnType<typeof makeModelAliases>
	readonly connections: ReturnType<typeof makeConnections>
	readonly overrides: ReturnType<typeof makeOverrides>
	readonly freeModels: ReturnType<typeof makeFreeModels>
	readonly probeModels: ReturnType<typeof makeProbeModels>
	readonly testConnections: ReturnType<typeof makeTestConnections>
	readonly checkConnection: ReturnType<typeof makeCheckConnection>
	readonly listProviderModels: ReturnType<typeof makeListProviderModels>
	readonly listClientConnections: ReturnType<typeof makeListClientConnections>
	readonly suggestModels: ReturnType<typeof makeSuggestModels>
	readonly validateCredential: ReturnType<typeof makeValidateCredential>
	readonly webLogin: ReturnType<typeof makeWebLogin>
	readonly customModels: ReturnType<typeof makeCustomModels>
	readonly disabledModels: ReturnType<typeof makeDisabledModels>
	readonly studioModels: ReturnType<typeof makeStudioModels>
	readonly providerNodes: ReturnType<typeof makeProviderNodes>
	readonly modelCatalogue: ReturnType<typeof makeModelCatalogue>
	readonly modelAvailability: ReturnType<typeof makeModelAvailability>
	readonly catalogueSync: ReturnType<typeof makeCatalogueSync>
	readonly modelProbe: ReturnType<typeof makeModelProbe>
	readonly baseUrlValidation: ReturnType<typeof makeBaseUrlValidation>
}

/** The combo use-cases share one dependency slice, so it is built once. */
function comboDeps(deps: Dependencies) {
	return {
		combos: deps.combos,
		studios: deps.studios,
		rotation: deps.comboRotation,
		presets: deps.comboPresets,
		strategies: deps.comboStrategies,
	}
}

export function buildUseCases(deps: Dependencies): UseCases {
	const combos = comboDeps(deps)
	return {
		createApiKey: makeCreateApiKey(deps),
		listApiKeys: makeListApiKeys(deps),
		revokeApiKey: makeRevokeApiKey(deps),
		dashboardKeys: makeManageApiKeys({
			keys: deps.dashboardApiKeys,
			audit: deps.apiKeyAudit,
			matchesAllowedModels: deps.matchesAllowedModels,
			endpointKinds: deps.endpointKinds,
		}),
		bulkEditKeys: makeBulkEditApiKeys({
			keys: deps.bulkApiKeys,
			audit: deps.apiKeyAudit,
		}),
		usageReports: makeUsageReports({ usage: deps.usageReports }),
		singleKey: makeManageSingleKey({
			keys: deps.singleApiKeys,
			audit: deps.singleKeyAudit,
			endpointKinds: deps.endpointKinds,
			matchesAllowedModels: deps.matchesAllowedModels,
			defaultPermissions: { viewUsage: true, manageApiKeys: false },
		}),
		getChangelog: () => loadChangelog(deps.changelog),
		getLoginGate: () => readLoginGate(deps.settings),
		listCombos: makeListCombos(combos),
		createCombo: makeCreateCombo(combos),
		getCombo: makeGetCombo(combos),
		updateCombo: makeUpdateCombo(combos),
		deleteCombo: makeDeleteCombo(combos),
		duplicateCombo: makeDuplicateCombo(combos),
		checkComboCycle: makeCheckComboCycle(combos),
		previewComboPresets: makePreviewComboPresets(combos),
		createComboPresets: makeCreateComboPresets(combos),
		listErrorLogs: makeListErrorLogs(deps.errorLogs),
		clearErrorLogs: makeClearErrorLogs(deps.errorLogs),
		settings: makeManageSettings({
			store: deps.settingsStore,
			...deps.settingsPassword,
			...deps.settingsWriteBack,
		}),
		settingsHistory: makeSettingsHistory({
			history: deps.settingsHistory.history,
			sanitize: deps.settingsHistory.sanitize,
			recordSecurityEvent: deps.settingsHistory.recordSecurityEvent,
			redact: deps.settingsHistory.redact,
			settings: deps.settingsStore,
			snapshot: async (before, actor, reason) => deps.settingsWriteBack.snapshot(before, reason),
		}),
		getTheme: makeGetTheme(deps.settings),
		setTheme: makeSetTheme(deps.settings),
		assertLocale: assertSupportedLocale,
		getPricing: makeGetPricing(deps.pricing),
		updatePricing: makeUpdatePricing(deps.pricing),
		resetPricing: makeResetPricing(deps.pricing),
		readPlugins: makeReadPlugins(deps.plugins, deps.pluginCatalogue),
		writePlugins: makeWritePlugins(deps.plugins, deps.pluginCatalogue, deps.pluginCache),
		cacheStats: makeCacheStats(deps.semanticCache),
		dashboardJobs: makeDashboardJobs(deps.dashboardJobRegistry, deps.dashboardJobEnv),
		shutdownFromDashboard: makeShutdownFromDashboard(deps.shutdown),
		shutdownFromHook: makeShutdownFromHook(deps.shutdown, deps.shutdownEnv),
		pxpipe: makePxpipe(deps.pxpipe, deps.pxpipeSettings),
		modelAliases: makeModelAliases({
			aliases: deps.modelAliases,
			reconciler: deps.allowedModelReconciler,
		}),
		overrides: makeOverrides({
			read: deps.providerOverrides.read,
			write: deps.providerOverrides.write,
			resolveAlias: deps.providerOverrides.resolveAlias,
			builtinHeaders: deps.providerOverrides.builtinHeaders,
		}),
		probeModels: makeProbeModels({
			connections: deps.connections,
			catalogue: deps.providerCatalogue,
			knownModels: deps.probeTargetsFor,
			aliasOf: deps.providerAliasOf,
			liveModels: deps.fetchConnectionModels,
			probe: deps.probeModel,
			isSerialProbe: deps.isSerialProbe,
		}),
		testConnections: makeTestConnections({
			connections: deps.connections,
			classifiers: deps.batchClassifiers,
			probe: deps.probeConnection,
			now: () => new Date().toISOString(),
		}),
		checkConnection: makeCheckConnection({ probe: deps.probeConnection }),
		listProviderModels: makeListProviderModels({
			connections: deps.connections,
			catalogue: deps.providerCatalogue,
			fetchModels: deps.fetchModels,
			resolveCustom: deps.resolveCustomModels,
		}),
		listClientConnections: makeListClientConnections({
			connections: deps.connections,
			nodes: deps.connectionNodes,
			registry: deps.clientListingRegistry,
			backfill: deps.backfillConnectionEmails,
		}),
		suggestModels: makeSuggestModels({
			catalogue: deps.suggestedCatalogue,
			findSyncable: deps.findSyncableCatalogue,
			readSynced: deps.readSyncedCatalogue,
			refreshSynced: deps.refreshSyncedCatalogue,
			fetchCatalogue: deps.fetchCatalogueUrl,
			armSyncer: deps.armCatalogueSyncer,
			timeoutMs: 12_000,
		}),
		validateCredential: makeValidateCredential({
			send: deps.sendProbe,
			findNode: async (provider) => deps.connectionNodes.find(provider),
			defaultModel: deps.defaultModelOf,
			providerConfig: deps.providerEntry,
			aiProvider: deps.aiProviderEntry,
			isOpenAICompatible: (provider) => deps.providerCatalogue.isOpenAICompatible(provider),
			isAnthropicCompatible: (provider) => deps.providerCatalogue.isAnthropicCompatible(provider),
			isCustomEmbedding: (provider) => deps.providerCatalogue.isCustomEmbedding(provider),
			probeAws: deps.probeAwsCredentials,
			probeQoder: deps.probeQoderCredentials,
			probeNous: deps.probeNousKey,
			ollamaLocalHost: deps.ollamaLocalHost,
			tokenplanBaseUrl: deps.tokenplanBaseUrl,
			commandCodeBody: deps.commandCodeBody,
			randomId: () => deps.randomId(),
		}),
		webLogin: makeWebLogin({
			...deps.webLogin,
			connections: deps.connections,
			providerLabel: (provider) => deps.providerCatalogue.label(provider),
		}),
		freeModels: makeFreeModels({
			fetchCatalogue: deps.fetchKiloCatalogue,
			cache: deps.freeModelCache,
			now: () => Date.now(),
		}),
		connections: makeConnections({
			connections: deps.connections,
			nodes: deps.connectionNodes,
			pools: deps.proxyPools,
			catalogue: deps.providerCatalogue,
			normalizeProviderId: deps.normalizeProviderId,
			normalizeProviderSpecificData: deps.normalizeProviderSpecificData,
			toResponse: deps.connectionResponse,
		}),
		customModels: makeCustomModels({
			models: deps.customModels,
			reconciler: deps.allowedModelReconciler,
			capabilityKeys: deps.modelCatalogue.capabilityKeys(),
			knownTransport: deps.knownSttTransport,
		}),
		disabledModels: makeDisabledModels({ disabled: deps.disabledModels }),
		studioModels: makeStudioModels({
			studios: deps.studioModels,
			combos: deps.comboReader,
			nodes: deps.nodePrefixes,
			reconciler: deps.allowedModelReconciler,
			resolveProviderAlias: deps.resolveProviderAlias,
			findCycle: deps.findStudioCycle,
		}),
		providerNodes: makeProviderNodes({
			nodes: deps.providerNodes,
			connections: deps.providerConnections,
			normalizeLogo: (value) => deps.modelCatalogue.normalizeLogo(value),
			generateId: () => deps.modelCatalogue.generateId(),
			prefixes: {
				openaiCompatible: "openai-compatible-",
				anthropicCompatible: "anthropic-compatible-",
				customEmbedding: "custom-embedding-",
			},
		}),
		modelCatalogue: makeModelCatalogue({
			catalogue: deps.modelCatalogue,
			aliases: deps.modelAliases,
			customModels: deps.customModels,
			studios: deps.studioModels,
			combos: deps.comboReader,
			disabledModels: deps.disabledModels,
			plugins: deps.pluginSettings,
		}),
		modelAvailability: makeModelAvailability({
			connections: deps.providerConnections,
			now: deps.now,
		}),
		catalogueSync: makeCatalogueSync({ sync: deps.catalogueSync }),
		modelProbe: makeModelProbe({ probe: deps.modelProbe }),
		baseUrlValidation: makeBaseUrlValidation({
			catalogue: deps.modelCatalogue,
			probeBaseUrl: (input) => deps.probeBaseUrl(input),
		}),
	}
}
