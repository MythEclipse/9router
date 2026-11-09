/** Dependencies: core slice. */
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

export interface DependenciesCore {
	/** The three collections the config export reads: providers, combos, keys. */
	readonly configExportSources: ConfigExportSources
	/** Pool storage plus the per-key counters the pool verdicts sum. */
	readonly budgetPoolStore: BudgetPoolStore
	/** Channel settings, the feed, the marker list, and the HTTP transport. */
	readonly alertPorts: AlertPorts
	/** The observability log, read by id or by page. */
	readonly replayPorts: ReplayPorts
	/** The key's budget and the model's rates, for the preflight ceiling. */
	readonly costCeiling: CeilingPorts
	/** Where uploads live. */
	readonly fileStore: FileStore
	/** Where batch jobs live, and how their result files are written. */
	readonly batchStore: BatchStore
	readonly batchFiles: BatchFiles
	/** Concurrency bound for outbound work, and the gate that enforces it. */
	readonly admissionLimits: GateLimits
	readonly admissionGate: import("./batches/admission.ts").AdmissionGate
	readonly apiKeys: IApiKeyRepository
	readonly dashboardApiKeys: ApiKeyManagementPort
	readonly bulkApiKeys: BulkEditPort
	readonly usageReports: UsageReportPort
	/** Timed requests in a window, for the latency report. */
	readonly latencySamples: import("./usage/latency-report.ts").LatencySamplePort
	/** Hourly spend per key plus the notification writer, for the anomaly detector. */
	readonly spendAnomalies: import("./usage/spend-anomaly.ts").SpendAnomalyPorts
	/** The claim/answer store behind `Idempotency-Key`. */
	readonly idempotencyStore: import("./idempotency/idempotency.ts").IdempotencyStore
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
	/** The settings audit trail and the revert that consumes it. */
	readonly settingsHistory: Pick<
		import("./settings/settings-history.ts").SettingsHistoryDependencies,
		"history" | "sanitize" | "recordSecurityEvent" | "redact"
	>
	/**
	 * The install's own storage, for export and import.
	 *
	 * A whole-install restore is not a settings write: it replaces every row at once,
	 * so it gets its own ports rather than reaching into the settings ones.
	 */
	readonly database: import("./settings/manage-database.ts").DatabaseDeps
	/** The scheduled backup: its stored config, its status, and its live scheduler. */
	readonly autoBackup: import("./settings/manage-auto-backup.ts").AutoBackupDeps
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
	/** The four relay providers' HTTP calls; the deploy use-case is shared. */
	readonly relayDeploy: DeployDeps
	/** The bulk-import job store; the job runs in the host's process. */
	readonly proxyImportJobs: ImportJobDeps
	/** The tunnel routes reach a process or a package manager; only the host can. */
	/** Importing credentials the operator already holds. */
	readonly credentialImport: Record<
		string,
		{
			readonly authType: string
			readonly backfill: BulkImportDeps["backfill"]
		}
	>
	readonly createProviderConnection: BulkImportDeps["create"]
	/** Where each provider's own tool left its credential; supplied by `apps/web`. */
	readonly localCredentials: Record<
		string,
		import("./oauth/auto-import.ts").LocalCredentialDeps<unknown>
	>
	/** Cursor's database needs a three-strategy read, so it has its own port. */
	readonly cursorImport: import("./oauth/auto-import.ts").CursorImportDeps
	/** Single-token imports: prove it works, then save it. */
	readonly tokenVerify: Record<string, import("./oauth/import-token.ts").ImportTokenDeps["verify"]>
	readonly newSystemId: () => string
	/** Long-lived keys: checked when possible, stored even when the check could not run. */
	readonly apiKeyCheck: Record<string, import("./oauth/import-api-key.ts").ApiKeyImportDeps["check"]>
	readonly findConnection: import("./oauth/import-api-key.ts").MimoImportDeps["findExisting"]
	readonly updateConnection: import("./oauth/import-api-key.ts").MimoImportDeps["update"]
	/** The OAuth dispatcher's session actions. */
	readonly oauthSession: import("./oauth/dispatch-actions.ts").DispatchDeps
}
