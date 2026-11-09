/** Use-cases: core A. */
/** Use-cases: core slice. */
import type { AuthStatus } from "../domain/auth-status.ts"
import type { ClaudeResetOutcome } from "../domain/claude-reset.ts"
import { invalid } from "../domain/errors.ts"
import type { MimoRegion } from "../domain/mimo-login.ts"
import { readMimoRegion } from "../domain/mimo-login.ts"
import type { makeBulkEditApiKeys } from "./api-keys/bulk-edit-api-keys.ts"
import type { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import type { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
import type { makeManageApiKeys } from "./api-keys/manage-api-keys-dashboard.ts"
import type { makeManageSingleKey } from "./api-keys/manage-single-key.ts"
import type { makeAuditLog } from "./audit/read-audit-log.ts"
import {
	type AuthStatusDeps,
	type AuthStatusPort,
	readAuthStatus,
} from "./auth-status/read-status.ts"
import type { AdmissionGate } from "./batches/admission.ts"
import type { makeBatches } from "./batches/batches.ts"
import type { loadChangelog } from "./changelog.ts"
import type { ClaudeResetPort } from "./claude-reset/reset-grant.ts"
import { spendResetGrant } from "./claude-reset/reset-grant.ts"
import type {
	ClaudeSettingsAnswer,
	ClaudeSettingsPort,
} from "./claude-tools/manage-claude-settings.ts"
import {
	readClaudeSettingsStatus,
	resetClaudeSettings,
	writeClaudeSettings,
} from "./claude-tools/manage-claude-settings.ts"
import type { ToolSettingsAnswer, ToolSettingsDeps } from "./cli-tools/manage-tool-settings.ts"
import {
	clearActiveModel,
	readToolSettingsStatus,
	removeToolModel,
	resetToolSettings,
	writeToolSettings,
} from "./cli-tools/manage-tool-settings.ts"
import type { AllStatusesAnswer } from "./cli-tools/read-all-statuses.ts"
import { readAllToolStatuses } from "./cli-tools/read-all-statuses.ts"
import type {
	DevinInstallPort,
	DevinStatusAnswer,
	DevinVersionPort,
} from "./cli-tools/read-devin-status.ts"
import { readDevinStatus } from "./cli-tools/read-devin-status.ts"
import type {
	CodexProfilesAnswer,
	CodexProfilesPort,
} from "./codex-profiles/manage-codex-profiles.ts"
import {
	deleteCodexProfile,
	listCodexProfiles,
	writeCodexProfile,
} from "./codex-profiles/manage-codex-profiles.ts"
import type { CodexAnswer, CodexResetPort } from "./codex-reset-credits/reset-credits.ts"
import { readResetCredits, redeemResetCredit } from "./codex-reset-credits/reset-credits.ts"
import type {
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
import type { McpProbeAnswer, ProbeFetch } from "./cowork-mcp/probe-mcp-tools.ts"
import { probeCoworkMcpTools } from "./cowork-mcp/probe-mcp-tools.ts"
import type { RegistryAnswer, RegistryCache } from "./cowork-mcp/read-mcp-registry.ts"
import { readMcpRegistry } from "./cowork-mcp/read-mcp-registry.ts"
import type { CoworkAnswer, CoworkDependencies } from "./cowork-settings/manage-cowork-settings.ts"
import {
	readCoworkSettings,
	resetCoworkSettings,
	writeCoworkSettings,
} from "./cowork-settings/manage-cowork-settings.ts"
import type { Dependencies } from "./dependencies.ts"
import type { makeClearErrorLogs, makeListErrorLogs } from "./error-logs/read-error-logs.ts"
import type { makeFiles } from "./files/files.ts"
import { makeHeadroom } from "./headroom/manage-headroom.ts"
import type {
	HermesAnswer,
	HermesFilesPort,
	HermesProfileSummary,
} from "./hermes/manage-hermes-settings.ts"
import {
	listHermesProfiles,
	readHermesSettings,
	resetHermesSettings as resetHermesSettingsUseCase,
	writeHermesSettings,
} from "./hermes/manage-hermes-settings.ts"
import type { makeIdempotency } from "./idempotency/idempotency.ts"
import { makeModelCatalogue } from "./models/list-models.ts"
import { makeCustomModels, makeModelAliases } from "./models/manage-aliases.ts"
import { makeModelAvailability } from "./models/manage-availability.ts"
import { makeCatalogueSync, makeModelProbe } from "./models/manage-catalogue-sync.ts"
import { makeBaseUrlValidation, makeDisabledModels } from "./models/manage-disabled-models.ts"
import { makeProviderNodes } from "./models/manage-provider-nodes.ts"
import { makeStudioModels } from "./models/manage-studio-models.ts"
import type { makeDispatchAlerts } from "./notifications/dispatch-alerts.ts"
import type { NotificationAnswer, NotificationStore } from "./notifications/read-notifications.ts"
import { readNotifications, updateNotification } from "./notifications/read-notifications.ts"
import type {
	NoticeWording,
	NotificationScanStore,
	ScanAnswer,
} from "./notifications/scan-notifications.ts"
import { scanNotifications } from "./notifications/scan-notifications.ts"
import { autoImportCursor, autoImportLocalCredential } from "./oauth/auto-import.ts"
import {
	type DispatchAnswer,
	pollSessionStatus,
	readIdeStatus,
	stopProviderProxy,
} from "./oauth/dispatch-actions.ts"
import type { GitlabPatAnswer } from "./oauth/gitlab-pat.ts"
import { importGitlabPat } from "./oauth/gitlab-pat.ts"
import type { IflowCookieAnswer } from "./oauth/iflow-cookie.ts"
import { importIflowCookie } from "./oauth/iflow-cookie.ts"
import { type ApiKeyAnswer, importKiroApiKey, importMimoApiKey } from "./oauth/import-api-key.ts"
import { importCredentialBatch } from "./oauth/import-credentials.ts"
import { importKiroCliAuth } from "./oauth/import-kiro-cli-auth.ts"
import { importAnswerOf, importToken, needsRemoteVerification } from "./oauth/import-token.ts"
import type { KiroSocialAnswer } from "./oauth/kiro-social.ts"
import { authorizeKiroSocial, exchangeKiroSocial } from "./oauth/kiro-social.ts"
import type { MimoLoginStartDeps, MimoLoginStarted } from "./oauth/mimo-login.ts"
import { startMimoLogin } from "./oauth/mimo-login.ts"
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
import { deployRelay } from "./proxy-pools/deploy-relay.ts"
import {
	cancelProxyImport,
	readProxyImportJobs,
	startProxyImport,
} from "./proxy-pools/import-proxy-pools.ts"
import {
	bulkDeleteProxyPools,
	createProxyPool,
	deleteProxyPool,
	listProxyPools,
	readProxyPool,
	testProxyPool,
	updateProxyPool,
} from "./proxy-pools/manage-proxy-pools.ts"
import { makePxpipe } from "./pxpipe/manage-pxpipe.ts"
import type { makeExplain } from "./requests/explain.ts"
import type { makeReplay } from "./requests/replay.ts"
import type { makeConfigExport } from "./settings/config-export.ts"
import { assertSupportedLocale } from "./settings/locale.ts"
import type { readLoginGate } from "./settings/login-gate.ts"
import {
	readAutoBackup,
	sendAutoBackupNow,
	writeAutoBackup,
} from "./settings/manage-auto-backup.ts"
import {
	readDatabase,
	readDatabaseJob,
	startDatabaseJob,
	writeDatabase,
} from "./settings/manage-database.ts"
import type { makeManageSettings } from "./settings/manage-settings.ts"
import type { makeSettingsHistory } from "./settings/settings-history.ts"
import { makeGetTheme, makeSetTheme } from "./settings/theme.ts"
import { makeCacheStats } from "./system/cache-stats.ts"
import { makeDashboardJobs } from "./system/dashboard-jobs.ts"
import { makeShutdownFromDashboard, makeShutdownFromHook } from "./system/shutdown.ts"
import type {
	DumpAnswer,
	DumpNameRule,
	TranslatorDumpStore,
} from "./translator/read-translator-dumps.ts"
import { loadDump, saveDump } from "./translator/read-translator-dumps.ts"
import { makeTtsVoices, type TtsVoices } from "./tts/tts-voices.ts"
import {
	checkTailscale,
	prepareTailscaleInstall,
	readTunnelStatus,
	runTailscaleInstall,
	type TunnelStatusCache,
	toggleTunnel,
} from "./tunnel/manage-tunnel.ts"
import type { makeBudgetPools } from "./usage/budget-pools.ts"
import type { makeCostCeiling } from "./usage/cost-ceiling.ts"
import { type KeyUsage, makeKeyUsageReport } from "./usage/key-usage-report.ts"
import type { makeLatencyReport } from "./usage/latency-report.ts"
import type { makeMetricsExposition } from "./usage/metrics-exposition.ts"
import type { makeModelCostComparison } from "./usage/model-cost-comparison.ts"
import { type ConnectionUsage, makeConnectionUsage } from "./usage/read-connection-usage.ts"
import type { makeUsageReports } from "./usage/report-usage.ts"
import type { makeSpendAnomalies } from "./usage/spend-anomaly.ts"
import type { makeSpendForecast } from "./usage/spend-forecast.ts"
import { makeUsagePanels, type UsagePanels } from "./usage/usage-panels.ts"

/**
 * What the auth-status use-case needs from its caller.
 *
 * `port` supplies the two reads that touch host state (settings row, auth cookie); `catalog`
 * supplies the permission sets so the domain never imports the database layer.
 */
export interface AuthStatusRequest {
	readonly port: AuthStatusPort
	readonly probes: AuthStatusDeps["probes"]
	readonly catalog: AuthStatusDeps["catalog"]
	readonly homePathFor: AuthStatusDeps["homePathFor"]
	readonly firstAllowedPage: AuthStatusDeps["firstAllowedPage"]
	readonly onFailure?: AuthStatusDeps["onFailure"]
}

export interface UseCasesCoreA {
	readonly createApiKey: ReturnType<typeof makeCreateApiKey>
	readonly listApiKeys: ReturnType<typeof makeListApiKeys>
	readonly revokeApiKey: ReturnType<typeof makeRevokeApiKey>
	/** The dashboard's key table: list, create with scoping, bulk edit. */
	readonly dashboardKeys: ReturnType<typeof makeManageApiKeys>
	readonly bulkEditKeys: ReturnType<typeof makeBulkEditApiKeys>
	readonly singleKey: ReturnType<typeof makeManageSingleKey>
	/** The read-only usage endpoints: stats, chart, sparks, logs, history. */
	readonly usageReports: ReturnType<typeof makeUsageReports>
	/** The spend projection: what the current daily rate says the period will cost. */
	readonly spendForecast: ReturnType<typeof makeSpendForecast>
	/** Latency percentiles per provider and model, from the timed requests in the window. */
	readonly latencyReport: ReturnType<typeof makeLatencyReport>
	/** Hours whose spend is far above their own trailing baseline. */
	readonly spendAnomalies: ReturnType<typeof makeSpendAnomalies>
	/** The admin audit trail, newest first. */
	readonly auditLog: ReturnType<typeof makeAuditLog>
	/** Claim/complete for `Idempotency-Key` on the non-streaming endpoints. */
	readonly idempotency: ReturnType<typeof makeIdempotency>
	/** The Prometheus scrape, composed from the leaderboard and the projection. */
	readonly metrics: ReturnType<typeof makeMetricsExposition>
	/** Cost per request and per million tokens, per model. */
	readonly modelCost: ReturnType<typeof makeModelCostComparison>
	/** The redacted, sorted configuration document. */
	readonly configExport: ReturnType<typeof makeConfigExport>
	/** Shared caps across several API keys. */
	readonly budgetPools: ReturnType<typeof makeBudgetPools>
	/** Sends the feed's notifications to the configured channels. */
	readonly alertDispatch: ReturnType<typeof makeDispatchAlerts>
	/** Turns captured requests into a translator regression suite. */
	readonly replay: ReturnType<typeof makeReplay>
	/** Explains one captured request: the pipeline, the diff, the cost. */
	readonly explain: ReturnType<typeof makeExplain>
	/** Preflight: does this request fit under the key's spending ceiling? */
	readonly costCeiling: ReturnType<typeof makeCostCeiling>
	/** Uploaded files behind `/v1/files`. */
	readonly files: ReturnType<typeof makeFiles>
	/** `/v1/batches`: a JSONL job file in, a results file out. */
	readonly batches: ReturnType<typeof makeBatches>
	/** The concurrency bound the batch runner shares, and what it reports about itself. */
	readonly admission: AdmissionGate
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
	/**
	 * Proxy pools.
	 *
	 * `remove` and `bulkRemove` answer a `PoolInUseError` when a connection still points at
	 * a pool; the boundary maps it to 409 and carries the count.
	 */
	readonly proxyPools: {
		readonly list: (query: URLSearchParams) => Promise<{ proxyPools: unknown[] }>
		readonly create: (body: Record<string, unknown>) => Promise<{
			proxyPool: import("./proxy-pools/manage-proxy-pools.ts").StoredPool
		}>
		readonly read: (id: string) => Promise<{
			proxyPool: import("./proxy-pools/manage-proxy-pools.ts").StoredPool
		}>
		readonly update: (
			id: string,
			body: Record<string, unknown>,
		) => Promise<{ proxyPool: import("./proxy-pools/manage-proxy-pools.ts").StoredPool }>
		readonly remove: (id: string) => Promise<{ success: true }>
		readonly bulkRemove: (body: Record<string, unknown>) => Promise<{
			deleted: string[]
			deletedCount: number
			missing: string[]
		}>
		readonly test: (id: string) => Promise<Record<string, unknown>>
		/** `POST /api/proxy-pools/<provider>-deploy` — one use-case, four providers. */
		readonly deploy: (
			provider: import("../domain/relay-deploy.ts").RelayProvider,
			body: Record<string, unknown>,
		) => Promise<{
			proxyPool: import("./proxy-pools/manage-proxy-pools.ts").StoredPool
			deployUrl: string
		}>
		/** Bulk import: start, poll, cancel. */
		readonly importJobs: {
			readonly start: (body: Record<string, unknown>) => {
				jobId: string
				status: string
				total: number
				pollMs: number
			}
			readonly read: (query: URLSearchParams) =>
				| { job: import("./proxy-pools/import-proxy-pools.ts").ImportJobView }
				| {
						jobs: readonly import("./proxy-pools/import-proxy-pools.ts").ImportJobView[]
				  }
			readonly cancel: (query: URLSearchParams) => { ok: true }
		}
	}
}
