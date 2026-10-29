/**
 * Use-case dependency container.
 *
 * Every side effect a use-case needs arrives here. Use-cases never import a
 * database, a cache, or a framework — which is what makes them testable with
 * plain fakes and keeps the composition root the single wiring point.
 */
import type { IApiKeyRepository } from "../domain/api-key.ts"
import type { CacheEntry, FreeModel, KiloModel } from "../domain/free-model-cache.ts"
import type { ProbeTarget } from "../domain/model-probe.ts"
import type { PricingResetTarget, PricingUpdate } from "../domain/pricing.ts"
import type { ProviderOverride } from "../domain/provider-override.ts"
import type { BulkEditPort } from "./api-keys/bulk-edit-api-keys.ts"
import type { ApiKeyManagementPort } from "./api-keys/manage-api-keys-dashboard.ts"
import type { SingleKeyAuditPort, SingleKeyPort } from "./api-keys/manage-single-key.ts"
import type { ChangelogSource } from "./changelog.ts"
import type {
	AllowedModelReconciler,
	CatalogueSyncPort,
	ComboReaderPort,
	CustomModelPort,
	DisabledModelPort,
	ModelAliasPort,
	ModelCataloguePort,
	ModelProbePort,
	NodePrefixPort,
	ProviderConnectionPort,
	ProviderNodePort,
	StudioModelPort,
} from "./models/ports.ts"
import type { PluginCache, PluginCatalogue, PluginSettingsPort } from "./plugins/manage-plugins.ts"
import type {
	ConnectionNodeStore,
	ConnectionStore,
	ProviderCatalogue,
	ProxyPoolStore,
	StoredConnection,
} from "./providers/ports.ts"

/** Where the override map lives, and how a URL id becomes a canonical one. */
export interface OverrideStore {
	read(): Promise<Record<string, ProviderOverride>>
	write(overrides: Record<string, ProviderOverride>): Promise<void>
	resolveAlias(id: string): string
	builtinHeaders(canonical: string): Record<string, string>
}

import type { PxpipePort, PxpipeSettings } from "./pxpipe/manage-pxpipe.ts"
import type { SettingsPort } from "./settings/login-gate.ts"
import type { SemanticCachePort } from "./system/cache-stats.ts"
import type { DashboardJobEnvironment, DashboardJobRegistry } from "./system/dashboard-jobs.ts"
import type { ShutdownEnvironment, ShutdownPorts } from "./system/shutdown.ts"
import type { UsageReportPort } from "./usage/report-usage.ts"

export interface IActivityRepository {
	record(entry: {
		action: string
		subject: string
		payload?: Record<string, unknown>
		at: Date
	}): Promise<void>
}

/** A combo as the dashboard sees it — the row, with `models` parsed. */
export interface ComboView {
	readonly id: string
	readonly name: string
	readonly models: string[]
	readonly kind: string | null
	/** 0 means auto: the window follows the largest member. */
	readonly contextWindow: number
	readonly createdAt: string
	readonly updatedAt: string
}

export interface ComboInput {
	readonly name: string
	readonly models: string[]
	readonly kind?: string | null
	readonly contextWindow?: number
	readonly [key: string]: unknown
}

export interface ComboPort {
	list(): Promise<ComboView[]>
	findById(id: string): Promise<ComboView | null>
	findByName(name: string): Promise<ComboView | null>
	create(input: ComboInput): Promise<ComboView>
	update(id: string, input: Partial<ComboInput>): Promise<ComboView | null>
	remove(id: string): Promise<boolean>
}

/**
 * Per-combo routing strategies, stored in settings keyed by combo name. A combo
 * rename or copy has to move the entry, or the copy silently runs on defaults.
 */
export interface ComboStrategyPort {
	read(comboName: string): Promise<unknown | null>
	write(comboName: string, strategy: unknown): Promise<void>
}

/** One combo a preset source proposes, and whether it already exists. */
export interface ComboPresetItem {
	readonly name: string
	readonly models: string[]
	readonly exists: boolean
}

/**
 * A source of combo presets — Cursor's live catalog, Claude's CLI aliases. The
 * catalogs live in `apps/web` beside the constants they read, so the use-case
 * asks for items instead of importing them.
 */
export interface ComboPresetPort {
	/** `existingNames` lets the adapter mark items already present. */
	list(source: string, existingNames: readonly string[]): Promise<ComboPresetItem[]>
	isSource(value: unknown): boolean
}

/** A studio (custom) model and the single model it targets. */
export interface StudioTarget {
	readonly callName: string
	readonly targetModel: string
}

export interface StudioTargetPort {
	list(): Promise<StudioTarget[]>
}

/**
 * Combo rotation state lives in the gateway's runtime, not the database. The
 * use-case only needs to invalidate it; how is not its concern.
 */
export interface ComboRotationPort {
	reset(comboName: string): void
}

/** One stored diagnostic entry, as the dashboard renders it. */
export interface ErrorLogEntry {
	readonly id: number
	readonly [key: string]: unknown
}

export interface ErrorLogPort {
	/** Newest first, capped by the caller. */
	list(limit: number): Promise<ErrorLogEntry[]>
	/**
	 * Returns false when the delete did not happen. The handler used to report
	 * success regardless, so a failed clear looked like a successful one.
	 */
	clear(): Promise<boolean>
}

/** provider → model → field → rate, as the repo returns it. */
export type PricingMap = Record<string, Record<string, Record<string, number>>>

export interface PricingPort {
	/** The catalog merged with the operator's overrides. */
	read(): Promise<PricingMap>
	/** Applies a validated update and returns the merged result. */
	update(update: PricingUpdate): Promise<PricingMap>
	/** Resets one model, one provider, or everything, per the target. */
	reset(target: PricingResetTarget): Promise<PricingMap>
}

/**
 * The dashboard's key-management ports. Separate from `apiKeys` because the two
 * answer different questions: `apiKeys` is about authenticating a request with a
 * key, this is about the table an operator edits.
 */
export interface Dependencies {
	readonly apiKeys: IApiKeyRepository
	readonly dashboardApiKeys: ApiKeyManagementPort
	readonly bulkApiKeys: BulkEditPort
	readonly usageReports: UsageReportPort
	readonly singleApiKeys: SingleKeyPort
	readonly singleKeyAudit: SingleKeyAuditPort
	readonly apiKeyAudit: {
		recordKeyCreated(event: {
			readonly actor: string
			readonly keyName: string
			readonly permissions: unknown
		}): Promise<void>
		recordBulkUpdate(event: {
			readonly updatedCount: number
			readonly fields: readonly string[]
		}): Promise<void>
	}
	/** The pattern language, injected so the domain never re-implements it. */
	readonly matchesAllowedModels: (patterns: readonly string[], model: string) => boolean
	/** The endpoint kinds this deployment serves, from `packages/db`. */
	readonly endpointKinds: readonly string[]
	readonly activity: IActivityRepository
	readonly changelog: ChangelogSource
	readonly settings: SettingsPort
	/** The settings row as a whole, for the general settings use-case. */
	readonly settingsStore: import("./settings/manage-settings.ts").SettingsDependencies["store"]
	/** Hashing and comparison for the settings row's password. */
	readonly settingsPassword: Pick<
		import("./settings/manage-settings.ts").SettingsDependencies,
		"comparePassword" | "hashPassword"
	>
	/** The before-image store and the effects a settings write owes the process. */
	readonly settingsWriteBack: Pick<
		import("./settings/manage-settings.ts").SettingsDependencies,
		"snapshot" | "effects" | "environmentFlags" | "logWarning"
	>
	readonly combos: ComboPort
	readonly errorLogs: ErrorLogPort
	readonly pricing: PricingPort
	readonly studios: StudioTargetPort
	readonly comboRotation: ComboRotationPort
	readonly comboPresets: ComboPresetPort
	readonly comboStrategies: ComboStrategyPort
	readonly plugins: PluginSettingsPort
	readonly pluginCatalogue: PluginCatalogue
	readonly pluginCache: PluginCache
	readonly semanticCache: SemanticCachePort
	readonly dashboardJobRegistry: DashboardJobRegistry
	readonly dashboardJobEnv: DashboardJobEnvironment
	readonly shutdown: ShutdownPorts
	readonly shutdownEnv: ShutdownEnvironment
	readonly pxpipe: PxpipePort
	readonly pxpipeSettings: PxpipeSettings
	readonly modelAliases: ModelAliasPort
	readonly disabledModels: DisabledModelPort
	readonly customModels: CustomModelPort
	readonly studioModels: StudioModelPort
	readonly allowedModelReconciler: AllowedModelReconciler
	readonly providerConnections: ProviderConnectionPort
	readonly providerNodes: ProviderNodePort
	readonly modelCatalogue: ModelCataloguePort
	/** Reads the custom-plugin settings, for the model list's badges. */
	readonly pluginSettings: {
		read(): Promise<{ adaptiveThinking?: { enabled?: boolean; models?: string[] } }>
	}
	readonly catalogueSync: CatalogueSyncPort
	readonly modelProbe: ModelProbePort
	readonly comboReader: ComboReaderPort
	readonly nodePrefixes: NodePrefixPort
	/** The studio cycle guard walks the combo graph, which lives in `apps/web`. */
	readonly findStudioCycle: (input: {
		callName: string
		comboName: string
		combosByName: Map<string, string[]>
		studioTargets: Map<string, string>
		extraSelfNames: string[]
	}) => string | null
	/** The STT transports the gateway can dial; anything else is dropped on write. */
	readonly knownSttTransport: (value: string) => boolean
	/** Provider connections. */
	readonly connections: ConnectionStore
	/** The nodes a compatible connection copies its base URL from. */
	readonly connectionNodes: ConnectionNodeStore
	/** Proxy pools, so a connection cannot name one that does not exist. */
	readonly proxyPools: ProxyPoolStore
	/** What kinds of provider exist, and which may be created. */
	readonly providerCatalogue: ProviderCatalogue
	/** Normalises the several spellings of a provider id to one. */
	readonly normalizeProviderId: (provider: unknown) => string
	/** Merges the provider-specific defaults a request body implies. */
	readonly normalizeProviderSpecificData: (
		provider: string,
		body: Record<string, unknown>,
		providerSpecificData: unknown,
	) => Record<string, unknown>
	/** Strips secrets before a connection leaves the process. */
	readonly connectionResponse: (connection: StoredConnection) => Record<string, unknown>
	/** The provider header overrides stored in the settings row. */
	readonly providerOverrides: OverrideStore
	/** The per-process cache the free-model list lives in. */
	readonly freeModelCache: {
		read(): CacheEntry<FreeModel[]> | null
		write(entry: CacheEntry<FreeModel[]>): void
	}
	/** Fetches Kilo's upstream catalogue. */
	readonly fetchKiloCatalogue: () => Promise<readonly KiloModel[]>
	/** The models the catalogue knows for a provider alias, for probing. */
	readonly probeTargetsFor: (alias: string) => readonly ProbeTarget[]
	/** The alias the router resolves a provider id through. */
	readonly providerAliasOf: (provider: string) => string
	/** Fetches a compatible connection's live model list. */
	readonly fetchConnectionModels: (
		connectionId: string,
	) => Promise<readonly Record<string, unknown>[] | null>
	/** Probes one model through the router. */
	readonly probeModel: (modelRef: string, kind: string) => Promise<Record<string, unknown>>
	/** Whether this provider serves one request at a time. */
	readonly isSerialProbe: (provider: string) => boolean
	/** Sends one validation probe and reports the status and body. */
	readonly sendProbe: (
		request: import("./providers/validate-credential.ts").ProbeRequest,
	) => Promise<import("./providers/validate-credential.ts").ProbeResponse>
	/** The provider's default model, for probes that need one. */
	readonly defaultModelOf: (provider: string) => string
	/** The provider's registry entry: base URL, format, headers, auth header. */
	readonly providerEntry: (
		provider: string,
	) => import("./providers/validate-credential.ts").RegistryEntry | undefined
	/** The provider's AI entry: noAuth, service kinds, credential form, probe configs. */
	readonly aiProviderEntry: (
		provider: string,
	) => import("./providers/validate-credential.ts").AiProviderEntry | undefined
	/** Probes AWS credentials, which have no bearer key. */
	readonly probeAwsCredentials: (input: {
		readonly apiKey: string
		readonly providerSpecificData?: Record<string, unknown>
	}) => Promise<{ readonly valid: boolean; readonly error: string | null }>
	/** Probes a Qoder PAT, which needs a token exchange first. */
	readonly probeQoderCredentials: (input: {
		readonly provider: string
		readonly apiKey: string
		readonly providerSpecificData?: Record<string, unknown>
	}) => Promise<{ readonly valid: boolean; readonly error: string | null }>
	/** Probes Nous, whose /models is public and proves nothing. */
	readonly probeNousKey: (
		apiKey: string,
	) => Promise<{ readonly valid: boolean; readonly error: string | null }>
	/** The two dynamic base URLs computed from the operator's own data. */
	readonly ollamaLocalHost: (input: { providerSpecificData?: Record<string, unknown> }) => string
	readonly tokenplanBaseUrl: (input: { providerSpecificData?: Record<string, unknown> }) => string
	/** Builds a CommandCode request body, which is not OpenAI-shaped. */
	readonly commandCodeBody: (model: string) => unknown
	/** The interactive web-login flow, backed by the browser driver. */
	readonly webLogin: Omit<
		import("./providers/web-login.ts").WebLoginDependencies,
		"connections" | "providerLabel"
	>
	/** The free/oauth/apikey/compatible questions a batch test groups by. */
	readonly batchClassifiers: import("../domain/batch-selection.ts").ProviderClassifiers
	/** What the client listing asks the catalogue about usage eligibility and order. */
	readonly clientListingRegistry: import("./providers/list-client-connections.ts").ClientListingRegistry
	/** Probes one connection and reports its verdict, writing back test status. */
	readonly probeConnection: (
		connectionId: string,
	) => Promise<import("../domain/batch-result.ts").ProbeOutcome>
	/** Repairs OAuth connection emails before the client listing reads them. */
	readonly backfillConnectionEmails: () => Promise<void>
	/** Fetch a provider's model list over HTTP, bounded by the request's timeout. */
	readonly fetchModels: import("./providers/list-provider-models.ts").ModelListDependencies["fetchModels"]
	/** Resolve a provider whose model list does not come from a fixed endpoint. */
	readonly resolveCustomModels: import("./providers/list-provider-models.ts").ModelListDependencies["resolveCustom"]
	/**
	 * The catalogue filters the suggested-models picker applies, keyed by fetcher
	 * type, with the built-in fallback entries for each.
	 */
	readonly suggestedCatalogue: import("../domain/model-catalogue.ts").CatalogueFilters
	/** The registry entry whose fetcher matches this url and type, if any. */
	readonly findSyncableCatalogue: (url: string, type: string) => { readonly id: string } | null
	/** The stored copy of a synced catalogue. */
	readonly readSyncedCatalogue: (
		entryId: string,
	) => Promise<import("./providers/suggest-models.ts").SyncedCatalogue | null>
	/** Refresh a stored catalogue copy in the background. */
	readonly refreshSyncedCatalogue: (entryId: string) => void
	/** Fetch an arbitrary catalogue URL, with the type's required headers. */
	readonly fetchCatalogueUrl: (url: string, type: string) => Promise<unknown>
	/** Arm the background free-catalogue syncer; idempotent. */
	readonly armCatalogueSyncer: () => void
	/** Maps a provider alias to the provider id the router uses. */
	readonly resolveProviderAlias: (prefix: string) => string
	/** Probes a base URL with a key, before a node is saved. */
	readonly probeBaseUrl: (input: {
		baseUrl: string
		apiKey: string
		type: string
		modelId?: string
	}) => Promise<Record<string, unknown>>
	readonly now: () => Date
	/** Injected so tests can pin key material instead of hoping. */
	readonly randomId: () => string
}
