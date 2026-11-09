/** Dependencies: extra slice. */
import type { IApiKeyRepository } from "../domain/api-key.ts"
import type { GateLimits } from "../domain/backpressure.ts"
import type { CacheEntry, FreeModel, KiloModel } from "../domain/free-model-cache.ts"
import type { ProbeTarget } from "../domain/model-probe.ts"
import type { PricingResetTarget, PricingUpdate } from "../domain/pricing.ts"
import type { ProviderOverride } from "../domain/provider-override.ts"
import type { BulkEditPort } from "./api-keys/bulk-edit-api-keys.ts"
import type { ApiKeyManagementPort } from "./api-keys/manage-api-keys-dashboard.ts"
import type { SingleKeyAuditPort, SingleKeyPort } from "./api-keys/manage-single-key.ts"
import type { BatchFiles, BatchStore } from "./batches/batches.ts"
import type { ChangelogSource } from "./changelog.ts"
import type {
	ComboPort,
	ComboPresetPort,
	ComboRotationPort,
	ComboStrategyPort,
	ErrorLogPort,
	IActivityRepository,
	OverrideStore,
	PricingPort,
	StudioTargetPort,
} from "./dependencies-ports.ts"
import type { FileStore } from "./files/files.ts"
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
import type { AlertPorts } from "./notifications/dispatch-alerts.ts"
import type { BulkImportDeps } from "./oauth/import-credentials.ts"
import type { PluginCache, PluginCatalogue, PluginSettingsPort } from "./plugins/manage-plugins.ts"
import type {
	ConnectionNodeStore,
	ConnectionStore,
	ProviderCatalogue,
	ProxyPoolStore,
	StoredConnection,
} from "./providers/ports.ts"
import type { DeployDeps } from "./proxy-pools/deploy-relay.ts"
import type { ImportJobDeps } from "./proxy-pools/import-proxy-pools.ts"
import type { PxpipePort, PxpipeSettings } from "./pxpipe/manage-pxpipe.ts"
import type { ReplayPorts } from "./requests/replay.ts"
import type { ConfigExportSources } from "./settings/config-export.ts"
import type { SettingsPort } from "./settings/login-gate.ts"
import type { SemanticCachePort } from "./system/cache-stats.ts"
import type { DashboardJobEnvironment, DashboardJobRegistry } from "./system/dashboard-jobs.ts"
import type { ShutdownEnvironment, ShutdownPorts } from "./system/shutdown.ts"
import type {
	TailscaleCheckDeps,
	TailscaleInstallDeps,
	TunnelProbeDeps,
	TunnelToggleDeps,
} from "./tunnel/manage-tunnel.ts"
import type { BudgetPoolStore } from "./usage/budget-pools.ts"
import type { CeilingPorts } from "./usage/cost-ceiling.ts"
import type { UsageReportPort } from "./usage/report-usage.ts"

export interface DependenciesExtra {
	/**
	 * Kiro's External-IdP normaliser. A host dependency because it reads the auth blob the way the
	 * Kiro CLI writes it, and that knowledge is the component's, not the use-case's.
	 */
	readonly kiroCliImport: import("./oauth/import-kiro-cli-auth.ts").KiroNormaliseDeps
	/**
	 * The fetch a credential check may use, chosen by who is asking.
	 *
	 * A remote caller must go through the SSRF guard — the base URL in a GitLab PAT import
	 * is client-supplied, and without the guard it can point the server at a loopback or
	 * metadata host. A local caller keeps self-hosted GitLab on a private network
	 * reachable, which is the whole point of the feature. That decision needs the request
	 * headers, so the host supplies the rule rather than the chosen fetch.
	 */
	readonly fetchForCaller: (headers: Headers) => typeof globalThis.fetch
	/** Kiro's social sign-in: PKCE, the login URL, and the code exchange. */
	readonly kiroSocial: {
		readonly authorize: import("./oauth/kiro-social.ts").KiroAuthorizeDeps
		readonly exchange: Omit<import("./oauth/kiro-social.ts").KiroExchangeDeps, "createConnection">
	}
	readonly tunnelProbes: TunnelProbeDeps
	readonly tunnelToggle: TunnelToggleDeps
	readonly tailscaleCheck: TailscaleCheckDeps
	readonly tailscaleInstall: TailscaleInstallDeps
	/** Headroom's process manager and python probe; only a host with a machine can supply them. */
	readonly headroom: import("./headroom/manage-headroom.ts").HeadroomDeps
	/** Per-key usage: the key list, its aggregate queries, and the budget rules. */
	readonly keyUsage: import("./usage/key-usage-report.ts").KeyUsageDeps
	/** The remaining usage panels: errors, leaderboard, providers, token savings, catalogue. */
	readonly usagePanels: import("./usage/usage-panels.ts").UsagePanelDeps
	/** Per-connection quota reads, including the refresh order that must not be reordered. */
	readonly connectionUsage: import("./usage/read-connection-usage.ts").ConnectionUsageDeps
	/** The TTS voice pickers' connections, fetchers and the four payload shapes they answer. */
	readonly ttsVoices: import("./tts/tts-voices.ts").TtsVoiceDeps
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
	/** The header set a CommandCode probe must send to pass for the CLI. */
	readonly commandCodeHeaders: (input: {
		readonly apiKey: string
		readonly sessionId?: string
	}) => Record<string, string>
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
