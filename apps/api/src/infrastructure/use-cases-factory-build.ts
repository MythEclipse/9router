/** Use-cases factory: tail deps. */
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
import type { makeAdmissionGate } from "../application/batches/admission.ts"
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
	type createModelCataloguePort,
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
import { type createSettingsPort, createSettingsRowPort } from "./settings-port.ts"
import { createUnavailablePresetPort } from "./unavailable-preset-port.ts"

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

import type { UseCaseOptions } from "./use-cases-factory-options.ts"
import {
	failingKiloFetch,
	identityProviderId,
	type unavailableConnectionHost,
	unavailableOverrideStore,
	unavailableProviderCatalogue,
	unavailableWebLogin,
	ungroupableProviders,
	unlistableProviders,
	unreachableProbe,
	unsupportedProbe,
} from "./use-cases-factory-unavailable.ts"
export interface TailCtx {
	readonly settingsPort: ReturnType<typeof createSettingsPort>
	readonly settingsRow: unknown
	readonly registryHost: unknown
	readonly catalogueHost: unknown
	readonly connectionHost: ReturnType<typeof unavailableConnectionHost>
	readonly catalogue: ReturnType<typeof createModelCataloguePort>
	readonly admissionLimits: { concurrency: number; queueCap: number }
	readonly admissionGate: ReturnType<typeof makeAdmissionGate>
	readonly db: unknown
	readonly sqlite: unknown
}
export function buildTailDeps(options: UseCaseOptions, ctx: TailCtx) {
	const {
		settingsPort,
		settingsRow,
		registryHost,
		catalogueHost,
		catalogue,
		admissionLimits,
		admissionGate,
	} = ctx as unknown as Record<string, unknown> as never
	return {
		tunnelProbes: required(options, "tunnelProbes"),
		tunnelToggle: required(options, "tunnelToggle"),
		tailscaleCheck: required(options, "tailscaleCheck"),
		tailscaleInstall: required(options, "tailscaleInstall"),
		headroom: required(options, "headroom"),
		ttsVoices: required(options, "ttsVoices"),
		// Keys and rows are read from the shared database; the visibility, budget and labelling
		// rules come from the host, because they read the dashboard's auth payload and its
		// static provider catalogue.
		keyUsage: { aggregatesOf: keyUsageAggregates, ...required(options, "keyUsage") },
		costCeiling: required(options, "costCeiling"),
		fileStore: fileStore(),
		batchStore: batchStore(),
		batchFiles: batchFiles(),
		admissionLimits,
		admissionGate,
		usagePanels: {
			errorRows: usageErrorRows,
			leaderboardRows: usageLeaderboardRows,
			...required(options, "usagePanels"),
		},
		connectionUsage: required(options, "connectionUsage"),
		// The three collections are read from the shared database, so the factory supplies them
		// rather than asking the host for a shape it would only forward.
		configExportSources: configExportSources(),
		budgetPoolStore: budgetPoolStore(),
		alertPorts: alertPorts(),
		replayPorts: replayPorts(),
		credentialImport: options.credentialImport ?? {},
		createProviderConnection: required(options, "createProviderConnection"),
		localCredentials: options.localCredentials ?? {},
		cursorImport: required(options, "cursorImport"),
		tokenVerify: options.tokenVerify ?? {},
		newSystemId: options.newSystemId ?? (() => crypto.randomUUID()),
		apiKeyCheck: options.apiKeyCheck ?? {},
		findConnection: required(options, "findConnection"),
		updateConnection: required(options, "updateConnection"),
		oauthSession: required(options, "oauthSession"),
		// The Kiro CLI normaliser is pure domain code now, so the factory supplies it directly
		// rather than asking the host — there is nothing to inject.
		kiroCliImport: { normalise: normalizeKiroExternalIdpAuth },
		/**
		 * Absent is a hard error, not a lenient default.
		 *
		 * A fallback of `globalThis.fetch` would silently skip the SSRF guard on the one
		 * path where a client-supplied base URL reaches it — the failure would look like a
		 * working import. A host that has no opinion must say `() => fetch`, and then the
		 * omission is in the code rather than in a default nobody reads.
		 */
		fetchForCaller: required(options, "fetchForCaller"),
		kiroSocial: required(options, "kiroSocial"),
		providerCatalogue: options.providerCatalogue ?? unavailableProviderCatalogue(),
		normalizeProviderId: options.normalizeProviderId ?? identityProviderId,
		normalizeProviderSpecificData: options.normalizeProviderSpecificData ?? (() => ({})),
		connectionResponse: options.connectionResponse ?? ((connection) => ({ ...connection })),
		providerOverrides: options.providerOverrides ?? unavailableOverrideStore(),
		freeModelCache: options.freeModelCache ?? { read: () => null, write: () => {} },
		fetchKiloCatalogue: options.fetchKiloCatalogue ?? failingKiloFetch,
		probeTargetsFor: options.probeTargetsFor ?? (() => []),
		providerAliasOf: options.providerAliasOf ?? ((provider) => provider),
		fetchConnectionModels: options.fetchConnectionModels ?? (async () => null),
		probeModel: options.probeModel ?? (async () => ({ valid: false, error: "not available" })),
		isSerialProbe: options.isSerialProbe ?? (() => false),
		sendProbe: options.sendProbe ?? unreachableProbe(),
		defaultModelOf: options.defaultModelOf ?? (() => ""),
		providerEntry: options.providerEntry ?? (() => undefined),
		aiProviderEntry: options.aiProviderEntry ?? (() => undefined),
		probeAwsCredentials: options.probeAwsCredentials ?? unsupportedProbe,
		probeQoderCredentials: options.probeQoderCredentials ?? unsupportedProbe,
		probeNousKey: options.probeNousKey ?? unsupportedProbe,
		ollamaLocalHost: options.ollamaLocalHost ?? (() => "http://localhost:11434"),
		tokenplanBaseUrl: options.tokenplanBaseUrl ?? (() => ""),
		commandCodeBody: options.commandCodeBody ?? (() => ({})),
		commandCodeHeaders: options.commandCodeHeaders ?? (() => ({})),
		webLogin: options.webLogin ?? unavailableWebLogin(),
		batchClassifiers: options.batchClassifiers ?? ungroupableProviders(),
		clientListingRegistry: options.clientListingRegistry ?? unlistableProviders(),
		probeConnection:
			options.probeConnection ??
			(async () => ({
				valid: false,
				error: "not available",
			})),
		backfillConnectionEmails: options.backfillConnectionEmails ?? (async () => {}),
		settingsStore: settingsRow,
		autoBackup: options.autoBackup ?? {
			config: async () => ({ enabled: false, channel: "telegram", intervalHours: 1 }),
			status: async () => ({}),
			saveConfig: async () => ({ enabled: false, channel: "telegram", intervalHours: 1 }),
			scheduler: () => ({ schedulerActive: false, nextRunAt: null }),
			configure: async () => {},
			sendNow: async () => {
				throw new Error("Backups are not available in this process")
			},
			verifyPassword: async () => false,
		},
		database: options.database ?? {
			verifyPassword: async () => false,
			summary: async () => ({ available: false }),
			exportSections: async () => ({ available: false }),
			importPayload: async () => {
				throw new Error("Database import is not available in this process")
			},
			afterImport: async () => {},
			startJob: () => {
				throw new Error("Database import is not available in this process")
			},
			findJob: () => null,
			verifyPollToken: () => false,
		},
		settingsHistory: options.settingsHistory ?? {
			history: {
				list: async () => [],
				count: async () => 0,
				find: async () => null,
			},
			sanitize: (patch) => patch,
			recordSecurityEvent: async () => {},
			redact: (settings) => settings,
		},
		settingsPassword: options.settingsPassword ?? {
			comparePassword: async () => false,
			hashPassword: async (plain) => plain,
		},
		settingsWriteBack: options.settingsWriteBack ?? {
			snapshot: async () => {},
			effects: {
				applyOutboundProxy: () => {},
				resetComboRotation: () => {},
				resetProxyHealth: () => {},
				reconfigureAutoPing: () => {},
			},
			environmentFlags: () => ({ requestLogs: false, translator: false }),
			logWarning: () => {},
		},
		fetchModels: options.fetchModels ?? (async () => ({ ok: false, status: 501, payload: null })),
		resolveCustomModels: options.resolveCustomModels ?? (async () => null),
		suggestedCatalogue: options.suggestedCatalogue ?? { filters: {}, fallbacks: {} },
		findSyncableCatalogue: options.findSyncableCatalogue ?? (() => null),
		readSyncedCatalogue: options.readSyncedCatalogue ?? (async () => null),
		refreshSyncedCatalogue: options.refreshSyncedCatalogue ?? (() => {}),
		fetchCatalogueUrl:
			options.fetchCatalogueUrl ??
			(async () => {
				throw new Error("catalogue fetch is not configured")
			}),
		armCatalogueSyncer: options.armCatalogueSyncer ?? (() => {}),
		// The cycle guard walks the combo graph and lives beside it in `apps/web`.
		findStudioCycle: options.findStudioCycle ?? (() => null),
		resolveProviderAlias: options.resolveProviderAlias ?? ((prefix) => prefix),
		knownSttTransport: options.knownSttTransport ?? (() => false),
		probeBaseUrl: options.probeBaseUrl ?? (async () => ({ valid: false, error: "not available" })),
		now: () => new Date(),
		randomId: () => randomUUID(),
	}
}
