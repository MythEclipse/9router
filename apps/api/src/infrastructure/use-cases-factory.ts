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
import type { ComboPresetPort, OverrideStore } from "../application/dependencies.ts"
import type { PluginCache } from "../application/plugins/manage-plugins.ts"
import type { ClientListingRegistry } from "../application/providers/list-client-connections.ts"
import type { ProviderCatalogue, StoredConnection } from "../application/providers/ports.ts"
import type { SyncedCatalogue } from "../application/providers/suggest-models.ts"
import type { ValidateCredentialDependencies as ValidateDependencies } from "../application/providers/validate-credential.ts"
import type { WebLoginDependencies } from "../application/providers/web-login.ts"
import { buildUseCases, type UseCases } from "../application/use-cases.ts"
import type { ProviderClassifiers } from "../domain/batch-selection.ts"
import type { CacheEntry, FreeModel, KiloModel } from "../domain/free-model-cache.ts"
import type { CatalogueFilters } from "../domain/model-catalogue.ts"
import type { ProbeTarget } from "../domain/model-probe.ts"
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
import {
	createComboRepository,
	createStudioTargetRepository,
} from "./db/repositories/combo-repository.ts"
import { createComboStrategyRepository } from "./db/repositories/combo-strategy-repository.ts"
import { createErrorLogRepository } from "./db/repositories/error-log-repository.ts"
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
import { createPricingRepository } from "./db/repositories/pricing-repository.ts"
import {
	type ConnectionHost,
	createConnectionNodeStore,
	createConnectionStore,
	createProxyPoolStore,
} from "./db/repositories/provider-connection-repository.ts"
import { createUsageReportPort } from "./db/repositories/usage-report-repository.ts"
import {
	type CatalogueHost,
	createCatalogueSyncPort,
	createModelCataloguePort,
	createModelProbePort,
} from "./model-catalogue-port.ts"
import { createPxpipePort, createPxpipeSettings } from "./pxpipe-port.ts"
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

export { installPxpipeEngine } from "./pxpipe-port.ts"
export { installSemanticCacheModule } from "./runtime-ports.ts"

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

	const useCases = buildUseCases({
		apiKeys: createApiKeyRepository(db),
		dashboardApiKeys: makeApiKeyManagementPort(options.apiKeyStore ?? unavailableApiKeyStore()),
		usageReports: createUsageReportPort(),
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
	})

	return { useCases, close: () => sqlite.close() }
}

/**
 * The plugin runtime caches its configuration in-process; a host that owns that
 * cache passes a clearer. Without one the write still lands, and the next request
 * that reads the settings row sees it — only a long-lived in-memory copy would
 * stay stale.
 */
function noPluginCache(): PluginCache {
	return { clear() {} }
}

/**
 * Stands in when the host has no `localDb`. Every call fails loudly: silently
 * returning an empty list would make the dashboard look like a fresh install.
 */
function unavailableApiKeyStore(): ApiKeyStore {
	const message = "API-key store is not available in this process"
	return {
		async list() {
			throw new Error(message)
		},
		async create() {
			throw new Error(message)
		},
		async findById() {
			throw new Error(message)
		},
		async update() {
			throw new Error(message)
		},
		async remove() {
			throw new Error(message)
		},
		async consistentMachineId() {
			throw new Error(message)
		},
	}
}

/**
 * Stands in when the host supplies no connection tables.
 *
 * Every call throws. Returning empty lists would make the dashboard render as a
 * fresh install with no providers — a wrong state that looks like a right one.
 */
function unavailableConnectionHost(): ConnectionHost {
	const message = "The provider-connection store is not available in this process"
	const fail = async (): Promise<never> => {
		throw new Error(message)
	}
	return {
		connections: { list: fail, find: fail, create: fail, update: fail, remove: fail },
		nodes: { find: fail, list: fail },
		pools: {
			exists: fail,
			list: fail,
			findById: fail,
			create: fail,
			update: fail,
			remove: fail,
			removeMany: fail,
			boundConnections: fail,
			supportedScheme: () => false,
			probe: fail,
		},
	}
}

/** Stands in when the host supplies no provider catalogue. */
function unavailableProviderCatalogue(): ProviderCatalogue {
	return {
		label: (provider) => provider,
		isOpenAICompatible: () => false,
		isAnthropicCompatible: () => false,
		isCustomEmbedding: () => false,
		isWebCookie: () => false,
		apiKeySubstituteField: () => null,
		isCreatable: () => false,
		usesAwsCredentialForm: () => false,
		modelListAdapter: () => ({ kind: "unsupported" }),
	}
}

/** The identity normaliser, for a host that sends one spelling of each id. */
function identityProviderId(provider: unknown): string {
	return typeof provider === "string" ? provider.trim() : ""
}

/** Stands in when the host has no settings row for overrides. */
function unavailableOverrideStore(): OverrideStore {
	const fail = async (): Promise<never> => {
		throw new Error("The provider-override store is not available in this process")
	}
	return {
		read: fail,
		write: fail,
		resolveAlias: (id) => id,
		builtinHeaders: () => ({}),
	}
}

/** A host that supplies no Kilo fetcher gets an explicit failure, not an empty list. */
async function failingKiloFetch(): Promise<never> {
	throw new Error("No Kilo catalogue fetcher was supplied")
}

/**
 * No classifiers: every connection groups as `apikey`.
 *
 * A host that cannot answer the free/oauth/apikey question must not silently make
 * `oauth` or `free` select nothing — an empty batch would read as "nothing to
 * test" when the truth is "this host cannot tell". Falling back to `apikey` puts
 * every connection in the group the route used as its own default.
 */
function ungroupableProviders(): ProviderClassifiers {
	return {
		isFree: () => false,
		isOAuth: () => false,
		isApiKey: () => false,
		isCompatible: () => false,
	}
}

/**
 * No registry: nothing is usage-eligible, so the client listing is empty.
 *
 * Empty rather than everything: this endpoint discloses connection details, and a
 * host that cannot say which providers support usage has no business answering
 * with a full list.
 */
function unlistableProviders(): ClientListingRegistry {
	return {
		isCompatible: () => false,
		supportsUsage: () => false,
		supportsApiKeyUsage: () => false,
		usageOrder: [],
	}
}

/**
 * No transport: a probe that refuses loudly.
 *
 * Throwing beats answering `{ valid: false }`: a host with no network access must
 * not tell the operator their key is bad when it never asked anyone.
 */
function unreachableProbe(): ValidateDependencies["send"] {
	return async () => {
		throw new Error("validation probes are not configured on this host")
	}
}

/** A probe this host cannot run, reported as unsupported rather than invalid. */
async function unsupportedProbe(): Promise<{ valid: boolean; error: string | null }> {
	return { valid: false, error: "Provider validation not supported" }
}

/**
 * No web-login driver: every session looks absent.
 *
 * `statusOf` returning null makes a poll answer 404, which is exactly right — there
 * is no login in progress because this host cannot start one. The store and the
 * label are supplied by `buildUseCases`, so they are not part of this slice.
 */
function unavailableWebLogin(): Omit<WebLoginDependencies, "connections" | "providerLabel"> {
	return {
		listProviders: () => [],
		listProfiles: () => [],
		configOf: () => null,
		statusOf: () => null,
		start: async () => {
			throw new Error("web login is not configured on this host")
		},
		cancel: () => false,
		fetchIdentity: async () => ({ status: "invalid", error: "web login is not configured" }),
	}
}
