/** Use-cases factory: options. */
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
	/** The four relay providers' HTTP calls, supplied by `apps/web`. */
	readonly relayDeploy?: DeployDeps
	/** The bulk-import job store, supplied by `apps/web`. */
	readonly proxyImportJobs?: ImportJobDeps
	/** The tunnel routes' machine access, supplied by `apps/web`. */
	readonly tunnelProbes?: TunnelProbeDeps
	readonly tunnelToggle?: TunnelToggleDeps
	readonly tailscaleCheck?: TailscaleCheckDeps
	readonly tailscaleInstall?: TailscaleInstallDeps
	readonly headroom?: import("../application/headroom/manage-headroom.ts").HeadroomDeps
	readonly ttsVoices?: import("../application/tts/tts-voices.ts").TtsVoiceDeps
	readonly keyUsage?: import("../application/usage/key-usage-report.ts").KeyUsageDeps
	readonly costCeiling?: import("../application/usage/cost-ceiling.ts").CeilingPorts
	readonly usagePanels?: import("../application/usage/usage-panels.ts").UsagePanelDeps
	readonly connectionUsage?: import("../application/usage/read-connection-usage.ts").ConnectionUsageDeps
	/** The credentials a provider's own tool leaves on this machine, supplied by `apps/web`. */
	readonly credentialImport?: Record<
		string,
		{
			readonly authType: string
			readonly backfill: (item: Record<string, unknown>) => Record<string, unknown>
		}
	>
	readonly createProviderConnection?: (input: Record<string, unknown>) => Promise<{ id: string }>
	readonly localCredentials?: Record<
		string,
		import("../application/oauth/auto-import.ts").LocalCredentialDeps<unknown>
	>
	readonly cursorImport?: import("../application/oauth/auto-import.ts").CursorImportDeps
	readonly tokenVerify?: Record<
		string,
		import("../application/oauth/import-token.ts").ImportTokenDeps["verify"]
	>
	readonly newSystemId?: () => string
	readonly apiKeyCheck?: Record<
		string,
		import("../application/oauth/import-api-key.ts").ApiKeyImportDeps["check"]
	>
	readonly findConnection?: import("../application/oauth/import-api-key.ts").MimoImportDeps["findExisting"]
	readonly updateConnection?: import("../application/oauth/import-api-key.ts").MimoImportDeps["update"]
	readonly oauthSession?: import("../application/oauth/dispatch-actions.ts").DispatchDeps
	/**
	 * The fetch a credential check may use, chosen from the caller's headers: a remote
	 * caller must go through the SSRF guard, a local one may reach a self-hosted GitLab.
	 * Omitted means every caller is treated as remote.
	 */
	readonly fetchForCaller?: (headers: Headers) => typeof globalThis.fetch
	/** Kiro's social sign-in: PKCE, the login URL, and the code exchange. */
	readonly kiroSocial?: {
		readonly authorize: import("../application/oauth/kiro-social.ts").KiroAuthorizeDeps
		readonly exchange: Omit<
			import("../application/oauth/kiro-social.ts").KiroExchangeDeps,
			"createConnection"
		>
	}
	/**
	 * Supplied by the host that owns `localDb`. Absent means the key-table
	 * use-cases are unavailable, which is the API-server case: it serves the
	 * secrets gate, not the dashboard's editor.
	 */
	readonly apiKeyStore?: ApiKeyStore
	/**
	 * Clears the host's in-memory plugin configuration. Omitted means there is
	 * no cache in this process, which is true for the API server.
	 */
	readonly pluginCache?: PluginCache
	/**
	 * Stops the background processes this app manages. Omitted means "this host
	 * manages none", which is the bare API server.
	 */
	readonly stopManagedProcesses?: () => Promise<void>
	/**
	 * Overrides how the shutdown closes the database, for a host whose handle is
	 * not the one this factory opened. Omitted means "close the one I opened".
	 */
	readonly closeDatabase?: () => Promise<void>
	/**
	 * The model registries. They live in `apps/web` beside the gateway's own
	 * reads, and this package cannot import that directory, so the host passes
	 * them in. Absent means the model endpoints are unavailable — which is the
	 * case for the bare API server.
	 */
	readonly registryHost?: RegistryHost
	/** The capability tables, free-provider registry and probe. See `registryHost`. */
	readonly catalogueHost?: CatalogueHost
	/** The connection, node and pool tables the provider-connection use-cases read. */
	readonly connectionHost?: ConnectionHost
	/** The provider catalogue, for deciding what may be created and what it is called. */
	readonly providerCatalogue?: ProviderCatalogue
	/** Normalises the several spellings of a provider id to one. */
	readonly normalizeProviderId?: (provider: unknown) => string
	/** Merges the provider-specific defaults a request body implies. */
	readonly normalizeProviderSpecificData?: (
		provider: string,
		body: Record<string, unknown>,
		providerSpecificData: unknown,
	) => Record<string, unknown>
	/** Strips secrets before a connection leaves the process. */
	readonly connectionResponse?: (connection: StoredConnection) => Record<string, unknown>
	/** The stored provider header overrides. */
	readonly providerOverrides?: OverrideStore
	/** The per-process free-model cache. */
	readonly freeModelCache?: {
		read(): CacheEntry<FreeModel[]> | null
		write(entry: CacheEntry<FreeModel[]>): void
	}
	/** Fetches Kilo's upstream catalogue. */
	readonly fetchKiloCatalogue?: () => Promise<readonly KiloModel[]>
	/** The models the catalogue knows for an alias. */
	readonly probeTargetsFor?: (alias: string) => readonly ProbeTarget[]
	/** The alias the router resolves a provider id through. */
	readonly providerAliasOf?: (provider: string) => string
	/** Fetches a compatible connection's live model list. */
	readonly fetchConnectionModels?: (
		connectionId: string,
	) => Promise<readonly Record<string, unknown>[] | null>
	/** Probes one model through the router. */
	readonly probeModel?: (modelRef: string, kind: string) => Promise<Record<string, unknown>>
	/** Whether this provider serves one request at a time. */
	readonly isSerialProbe?: (provider: string) => boolean
	/** Sends one validation probe and reports the status and body. */
	readonly sendProbe?: ValidateDependencies["send"]
	readonly defaultModelOf?: ValidateDependencies["defaultModel"]
	readonly providerEntry?: ValidateDependencies["providerConfig"]
	readonly aiProviderEntry?: ValidateDependencies["aiProvider"]
	readonly probeAwsCredentials?: ValidateDependencies["probeAws"]
	readonly probeQoderCredentials?: ValidateDependencies["probeQoder"]
	readonly probeNousKey?: ValidateDependencies["probeNous"]
	readonly ollamaLocalHost?: ValidateDependencies["ollamaLocalHost"]
	readonly tokenplanBaseUrl?: ValidateDependencies["tokenplanBaseUrl"]
	readonly commandCodeBody?: ValidateDependencies["commandCodeBody"]
	readonly commandCodeHeaders?: ValidateDependencies["commandCodeHeaders"]
	readonly deepaiCodeHeaders?: ValidateDependencies["deepaiCodeHeaders"]
	/** The interactive web-login flow, backed by the browser driver. */
	readonly webLogin?: Omit<WebLoginDependencies, "connections" | "providerLabel">
	/** The free/oauth/apikey/compatible questions a batch test groups by. */
	readonly batchClassifiers?: ProviderClassifiers
	/** What the client listing asks the catalogue about usage eligibility and order. */
	readonly clientListingRegistry?: ClientListingRegistry
	/** Probes one connection and reports its verdict. */
	readonly probeConnection?: (
		connectionId: string,
	) => Promise<import("../domain/batch-result.ts").ProbeOutcome>
	/** Repairs OAuth connection emails before the client listing reads them. */
	readonly backfillConnectionEmails?: () => Promise<void>
	/** The settings audit trail and the revert that consumes it. */
	readonly settingsHistory?: Pick<
		import("../application/settings/settings-history.ts").SettingsHistoryDependencies,
		"history" | "sanitize" | "recordSecurityEvent" | "redact"
	>
	/**
	 * The install's own storage. Optional so a caller that only exercises the
	 * settings row (most tests) need not stand up a database exporter; the default
	 * refuses every attempt rather than pretending a backup succeeded.
	 */
	readonly database?: import("../application/settings/manage-database.ts").DatabaseDeps
	/**
	 * The backup scheduler. Optional for the same reason as `database`: a caller that
	 * only exercises the settings row should not have to own a scheduler, and the
	 * default reports "off" rather than pretending a backup is armed.
	 */
	readonly autoBackup?: import("../application/settings/manage-auto-backup.ts").AutoBackupDeps
	/** The settings row as a whole, for the general settings use-case. */
	readonly settingsStore?: import("../application/settings/manage-settings.ts").SettingsDependencies["store"]
	/** Hashing and comparison for the settings row's password. */
	readonly settingsPassword?: Pick<
		import("../application/settings/manage-settings.ts").SettingsDependencies,
		"comparePassword" | "hashPassword"
	>
	/** The before-image store and the effects a settings write owes the process. */
	readonly settingsWriteBack?: Pick<
		import("../application/settings/manage-settings.ts").SettingsDependencies,
		"snapshot" | "effects" | "environmentFlags" | "logWarning"
	>
	/** Fetch a provider's model list over HTTP. */
	readonly fetchModels?: import("../application/providers/list-provider-models.ts").ModelListDependencies["fetchModels"]
	/** Resolve a provider whose model list does not come from a fixed endpoint. */
	readonly resolveCustomModels?: import("../application/providers/list-provider-models.ts").ModelListDependencies["resolveCustom"]
	/** The suggested-models filter table and its built-in fallbacks. */
	readonly suggestedCatalogue?: CatalogueFilters
	/** The registry entry whose fetcher matches this url and type. */
	readonly findSyncableCatalogue?: (url: string, type: string) => { readonly id: string } | null
	/** The stored copy of a synced catalogue. */
	readonly readSyncedCatalogue?: (entryId: string) => Promise<SyncedCatalogue | null>
	/** Refresh a stored catalogue copy in the background. */
	readonly refreshSyncedCatalogue?: (entryId: string) => void
	/** Fetch an arbitrary catalogue URL. */
	readonly fetchCatalogueUrl?: (url: string, type: string) => Promise<unknown>
	/** Arm the background free-catalogue syncer; idempotent. */
	readonly armCatalogueSyncer?: () => void
	/**
	 * The studio cycle guard walks the combo graph, which lives in `apps/web`.
	 * Absent means no guard, and a cycle would only surface as a request timeout.
	 */
	readonly findStudioCycle?: (input: {
		callName: string
		comboName: string
		combosByName: Map<string, string[]>
		studioTargets: Map<string, string>
		extraSelfNames: string[]
	}) => string | null
	/** Maps a provider alias to the provider id the router resolves. */
	readonly resolveProviderAlias?: (prefix: string) => string
	/** The STT transports the gateway can dial; absent means "none recognised". */
	readonly knownSttTransport?: (value: string) => boolean
	/** Probes a base URL with a key, before a node is saved. */
	readonly probeBaseUrl?: (input: {
		baseUrl: string
		apiKey: string
		type: string
		modelId?: string
	}) => Promise<Record<string, unknown>>
}
