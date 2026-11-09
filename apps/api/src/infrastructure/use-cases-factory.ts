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
import { CUSTOM_PLUGIN_KEYS } from "@9router/db/shared/pluginKeys"
import { makeAdmissionGate } from "../application/batches/admission.ts"
import type { ComboPresetPort, OverrideStore } from "../application/dependencies.ts"
import type { PluginCache } from "../application/plugins/manage-plugins.ts"
import type { ClientListingRegistry } from "../application/providers/list-client-connections.ts"
import type { ProviderCatalogue, StoredConnection } from "../application/providers/ports.ts"
import type { SyncedCatalogue } from "../application/providers/suggest-models.ts"
import type { ValidateCredentialDependencies as ValidateDependencies } from "../application/providers/validate-credential.ts"
import type { WebLoginDependencies } from "../application/providers/web-login.ts"
import type { DeployDeps } from "../application/proxy-pools/deploy-relay.ts"
import type { ImportJobDeps } from "../application/proxy-pools/import-proxy-pools.ts"
import type {
	TailscaleCheckDeps,
	TailscaleInstallDeps,
	TunnelProbeDeps,
	TunnelToggleDeps,
} from "../application/tunnel/manage-tunnel.ts"
import { buildUseCases, type UseCases } from "../application/use-cases.ts"
import { positiveInt } from "../domain/backpressure.ts"
import type { ProviderClassifiers } from "../domain/batch-selection.ts"
import type { CacheEntry, FreeModel, KiloModel } from "../domain/free-model-cache.ts"
import { normalizeKiroExternalIdpAuth } from "../domain/kiro-external-idp.ts"
import type { CatalogueFilters } from "../domain/model-catalogue.ts"
import type { ProbeTarget } from "../domain/model-probe.ts"
import { batchFiles, batchStore } from "./batches/batch-store.ts"
import { createChangelogSourceFromDisk } from "./changelog-source.ts"
import { createComboRotationPort } from "./combo-rotation-port.ts"
import { createDb, resolveDataDir } from "./db/client.ts"
import { runMigrations } from "./db/migrate.ts"
import { createActivityRepository } from "./db/repositories/activity-repository.ts"
import {
	API_KEY_ENDPOINT_KINDS,
	type ApiKeyStore,
	makeApiKeyAuditPort,
	makeApiKeyManagementPort,
	makeBulkEditPort,
	makeSingleKeyAuditPort,
	makeSingleKeyPort,
	matchesAllowedModels,
} from "./db/repositories/api-key-dashboard-repository.ts"
import { createApiKeyRepository } from "./db/repositories/api-key-repository.ts"
import { budgetPoolStore } from "./db/repositories/budget-pool-repository.ts"
import {
	createComboRepository,
	createStudioTargetRepository,
} from "./db/repositories/combo-repository.ts"
import { createComboStrategyRepository } from "./db/repositories/combo-strategy-repository.ts"
import { configExportSources } from "./db/repositories/config-export-repository.ts"
import { createErrorLogRepository } from "./db/repositories/error-log-repository.ts"
import { createIdempotencyStore } from "./db/repositories/idempotency-repository.ts"
import { aggregatesOf as keyUsageAggregates } from "./db/repositories/key-usage-repository.ts"
import {
	createAllowedModelReconciler,
	createComboReaderPort,
	createCustomModelPort,
	createDisabledModelPort,
	createModelAliasPort,
	createNodePrefixPort,
	createProviderConnectionPort,
	createProviderNodePort,
	createStudioModelPort,
	type RegistryHost,
} from "./db/repositories/model-registry-repository.ts"
import {
	createLatencySamplePort,
	createSpendAnomalyPorts,
} from "./db/repositories/observability-repository.ts"
import { createPricingRepository } from "./db/repositories/pricing-repository.ts"
import {
	type ConnectionHost,
	createConnectionNodeStore,
	createConnectionStore,
	createProxyPoolStore,
} from "./db/repositories/provider-connection-repository.ts"
import {
	errorRows as usageErrorRows,
	leaderboardRows as usageLeaderboardRows,
} from "./db/repositories/usage-panel-repository.ts"
import { createUsageReportPort } from "./db/repositories/usage-report-repository.ts"
import { fileStore } from "./files/file-store.ts"
import {
	type CatalogueHost,
	createCatalogueSyncPort,
	createModelCataloguePort,
	createModelProbePort,
} from "./model-catalogue-port.ts"
import { alertPorts } from "./notifications/alert-ports.ts"
import { createPxpipePort, createPxpipeSettings } from "./pxpipe-port.ts"
import { replayPorts } from "./requests/replay-ports.ts"
import { required as takeRequired } from "./requiredPort.ts"
import {
	createDashboardJobEnvironment,
	createDashboardJobRegistry,
	createSemanticCachePort,
	createShutdownEnvironment,
	createShutdownPorts,
	DASHBOARD_JOB_KINDS,
} from "./runtime-ports.ts"
import { createSettingsPort, createSettingsRowPort } from "./settings-port.ts"
import { createUnavailablePresetPort } from "./unavailable-preset-port.ts"
import type { UseCaseOptions } from "./use-cases-factory-options.ts"

export type { UseCaseOptions } from "./use-cases-factory-options.ts"

import { buildTailDeps, type TailCtx } from "./use-cases-factory-build.ts"
import {
	identityProviderId,
	noPluginCache,
	unavailableApiKeyStore,
	unavailableConnectionHost,
} from "./use-cases-factory-unavailable.ts"

export { installPxpipeEngine } from "./pxpipe-port.ts"
export { installSemanticCacheModule } from "./runtime-ports.ts"

export interface UseCasesHandle {
	readonly useCases: UseCases
	/** Released by the owning process on shutdown. */
	close(): void
}

/**
 * Read an option the use-cases cannot run without.
 *
 * Named one at a time so the error says which host wiring is missing, rather than a single
 * "dependencies incomplete" that sends the reader through the whole options type.
 */
export function required<K extends keyof UseCaseOptions>(
	options: UseCaseOptions,
	key: K,
): NonNullable<UseCaseOptions[K]> {
	return takeRequired(
		options as unknown as Readonly<Record<string, unknown>>,
		key as string,
	) as NonNullable<UseCaseOptions[K]>
}

export function createUseCases(
	options: UseCaseOptions = { comboPresets: createUnavailablePresetPort() },
): UseCasesHandle {
	const dataDir = resolveDataDir(options.dataDir ?? process.env.DATA_DIR)
	const { db, sqlite } = createDb(dataDir)
	runMigrations(sqlite, dataDir, { migrationsDir: options.migrationsDir })

	// One port over the settings row, shared by the login gate, the plugin panel
	// and pxpipe: the same row read three ways would be three chances to disagree.
	const settingsPort = createSettingsPort()
	// The general settings use-case needs the whole row, not the projection the
	// theme/login-gate/plugin use-cases read.
	const settingsRow = options.settingsStore ?? createSettingsRowPort()
	if (!options.registryHost || !options.catalogueHost) {
		throw new Error(
			"The model-registry use-cases need registryHost and catalogueHost; this host did not supply them",
		)
	}
	const registryHost = options.registryHost
	const catalogueHost = options.catalogueHost
	const connectionHost = options.connectionHost ?? unavailableConnectionHost()
	const catalogue = createModelCataloguePort(catalogueHost)

	// One gate per process: the bound describes this event loop's outbound budget, so a second
	// gate would only measure half the traffic and enforce nothing.
	//
	// A slot is held for as long as one answer keeps arriving, so capacity is
	// `concurrency / meanServiceMs` — 8 slots against a 24 s mean is a third of a request per
	// second for the whole gateway, which is below what a single coding agent produces. Both
	// numbers are deploy-time knobs rather than source constants, because the right value
	// depends on how many streams the box is expected to serve. Env: ADMISSION_CONCURRENCY,
	// ADMISSION_QUEUE_CAP.
	const admissionLimits = {
		concurrency: positiveInt(Number(process.env.ADMISSION_CONCURRENCY), 8),
		queueCap: positiveInt(Number(process.env.ADMISSION_QUEUE_CAP), 32),
	}
	const admissionGate = makeAdmissionGate(admissionLimits)
	const ctx: TailCtx = {
		settingsPort,
		settingsRow,
		registryHost,
		catalogueHost,
		connectionHost,
		catalogue,
		admissionLimits,
		admissionGate,
		db,
		sqlite,
	}

	const useCases = buildUseCases({
		apiKeys: createApiKeyRepository(db),
		dashboardApiKeys: makeApiKeyManagementPort(options.apiKeyStore ?? unavailableApiKeyStore()),
		usageReports: createUsageReportPort(),
		latencySamples: createLatencySamplePort(),
		spendAnomalies: createSpendAnomalyPorts(),
		idempotencyStore: createIdempotencyStore(db),
		bulkApiKeys: makeBulkEditPort(options.apiKeyStore ?? unavailableApiKeyStore()),
		singleApiKeys: makeSingleKeyPort(options.apiKeyStore ?? unavailableApiKeyStore()),
		singleKeyAudit: makeSingleKeyAuditPort(),
		apiKeyAudit: makeApiKeyAuditPort(),
		matchesAllowedModels,
		endpointKinds: API_KEY_ENDPOINT_KINDS,
		activity: createActivityRepository(db, () => randomUUID()),
		changelog: createChangelogSourceFromDisk(options.webAppDir ?? "apps/web"),
		settings: settingsPort,
		combos: createComboRepository(),
		errorLogs: createErrorLogRepository(),
		pricing: createPricingRepository(),
		studios: createStudioTargetRepository(),
		comboPresets: options.comboPresets,
		comboStrategies: createComboStrategyRepository(),
		comboRotation: createComboRotationPort({
			gatewayUrl: options.gatewayUrl,
			onError: options.onRotationError,
		}),
		plugins: settingsPort,
		pluginCatalogue: { keys: CUSTOM_PLUGIN_KEYS },
		pluginCache: options.pluginCache ?? noPluginCache(),
		semanticCache: createSemanticCachePort(),
		dashboardJobRegistry: createDashboardJobRegistry(),
		dashboardJobEnv: createDashboardJobEnvironment(DASHBOARD_JOB_KINDS),
		shutdown: createShutdownPorts({
			/*
			 * The host's own close wins when it has one: the dashboard holds the
			 * shared driver (`@9router/db/driver`), whose handle is not the one this
			 * factory opened, and closing only ours would leave the shared one open.
			 */
			closeDatabase: options.closeDatabase ?? (async () => sqlite.close()),
			stopManagedProcesses: async () => options.stopManagedProcesses?.(),
		}),
		shutdownEnv: createShutdownEnvironment(),
		pxpipe: createPxpipePort(),
		pxpipeSettings: createPxpipeSettings(async () => {
			const stored = await settingsPort.read()
			return {
				enabled: stored.pxpipeEnabled === true,
				autoInstall: stored.pxpipeAutoInstall === true,
				minChars: stored.pxpipeMinChars,
				timeoutMs: stored.pxpipeTimeoutMs,
			}
		}),
		modelAliases: createModelAliasPort(registryHost),
		disabledModels: createDisabledModelPort(registryHost),
		customModels: createCustomModelPort(registryHost),
		studioModels: createStudioModelPort(registryHost),
		allowedModelReconciler: createAllowedModelReconciler(registryHost),
		providerConnections: createProviderConnectionPort(registryHost),
		providerNodes: createProviderNodePort(registryHost),
		modelCatalogue: catalogue,
		pluginSettings: {
			async read() {
				const stored = await settingsPort.read()
				const plugins = (stored.customPlugins ?? {}) as Record<string, unknown>
				const adaptive = plugins.adaptiveThinking as
					| { enabled?: boolean; models?: string[] }
					| undefined
				return { adaptiveThinking: adaptive }
			},
		},
		catalogueSync: createCatalogueSyncPort(catalogueHost),
		modelProbe: createModelProbePort(catalogueHost),
		comboReader: createComboReaderPort(registryHost),
		nodePrefixes: createNodePrefixPort(registryHost),
		// The connection use-cases need their own tables; a host that supplies none
		// gets stores that refuse loudly rather than an empty dashboard.
		connections: createConnectionStore(connectionHost),
		connectionNodes: createConnectionNodeStore(connectionHost),
		proxyPools: createProxyPoolStore(connectionHost),
		// Deploying a relay calls a provider's HTTP API, which only the host can do; a
		// factory that invented a no-op would deploy nothing and report success.
		relayDeploy: (() => {
			if (!options.relayDeploy) throw new Error("The proxy-pool deploy use-case needs relayDeploy")
			return options.relayDeploy
		})(),
		// The import job runs in the host's process and holds its own rows; a factory that
		// invented a store would start a job nobody could poll.
		proxyImportJobs: (() => {
			if (!options.proxyImportJobs) {
				throw new Error("The proxy-pool import use-cases need proxyImportJobs")
			}
			return options.proxyImportJobs
		})(),
		// Every tunnel verb reaches a process, a socket or a package manager, so a factory that
		// invented one would report a tunnel it never touched.
		...buildTailDeps(options, ctx),
	})

	return { useCases, close: () => sqlite.close() }
}
