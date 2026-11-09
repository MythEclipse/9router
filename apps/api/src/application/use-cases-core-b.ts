/** Use-cases: core B. */

/** Use-cases: core slice. */
import type { AuthStatus } from "../domain/auth-status.ts"
import type { ClaudeResetOutcome } from "../domain/claude-reset.ts"
import { invalid } from "../domain/errors.ts"
import type { MimoRegion } from "../domain/mimo-login.ts"
import { readMimoRegion } from "../domain/mimo-login.ts"
import { makeBulkEditApiKeys } from "./api-keys/bulk-edit-api-keys.ts"
import { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
import { makeManageApiKeys } from "./api-keys/manage-api-keys-dashboard.ts"
import { makeManageSingleKey } from "./api-keys/manage-single-key.ts"
import { makeAuditLog } from "./audit/read-audit-log.ts"
import {
	type AuthStatusDeps,
	type AuthStatusPort,
	readAuthStatus,
} from "./auth-status/read-status.ts"
import type { AdmissionGate } from "./batches/admission.ts"
import { makeBatches } from "./batches/batches.ts"
import { loadChangelog } from "./changelog.ts"
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
import { makeClearErrorLogs, makeListErrorLogs } from "./error-logs/read-error-logs.ts"
import { makeFiles } from "./files/files.ts"
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
import { makeIdempotency } from "./idempotency/idempotency.ts"
import type { makeModelCatalogue } from "./models/list-models.ts"
import type { makeCustomModels, makeModelAliases } from "./models/manage-aliases.ts"
import type { makeModelAvailability } from "./models/manage-availability.ts"
import type { makeCatalogueSync, makeModelProbe } from "./models/manage-catalogue-sync.ts"
import type { makeBaseUrlValidation, makeDisabledModels } from "./models/manage-disabled-models.ts"
import type { makeProviderNodes } from "./models/manage-provider-nodes.ts"
import type { makeStudioModels } from "./models/manage-studio-models.ts"
import { makeDispatchAlerts } from "./notifications/dispatch-alerts.ts"
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
import type { makeReadPlugins, makeWritePlugins } from "./plugins/manage-plugins.ts"
import type {
	makeGetPricing,
	makeResetPricing,
	makeUpdatePricing,
} from "./pricing/manage-pricing.ts"
import type { makeCheckConnection } from "./providers/check-connection.ts"
import type { makeListClientConnections } from "./providers/list-client-connections.ts"
import type { makeFreeModels } from "./providers/list-free-models.ts"
import type { makeListProviderModels } from "./providers/list-provider-models.ts"
import type { makeConnections } from "./providers/manage-connections.ts"
import type { makeOverrides } from "./providers/manage-overrides.ts"
import type { makeProbeModels } from "./providers/probe-models.ts"
import type { makeSuggestModels } from "./providers/suggest-models.ts"
import type { makeTestConnections } from "./providers/test-connections.ts"
import type { makeValidateCredential } from "./providers/validate-credential.ts"
import type { makeWebLogin } from "./providers/web-login.ts"
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
import type { makePxpipe } from "./pxpipe/manage-pxpipe.ts"
import { makeExplain } from "./requests/explain.ts"
import { makeReplay } from "./requests/replay.ts"
import { makeConfigExport } from "./settings/config-export.ts"
import { assertSupportedLocale } from "./settings/locale.ts"
import { readLoginGate } from "./settings/login-gate.ts"
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
import { makeManageSettings } from "./settings/manage-settings.ts"
import { makeSettingsHistory } from "./settings/settings-history.ts"
import type { makeGetTheme, makeSetTheme } from "./settings/theme.ts"
import type { makeCacheStats } from "./system/cache-stats.ts"
import type { makeDashboardJobs } from "./system/dashboard-jobs.ts"
import type { makeShutdownFromDashboard, makeShutdownFromHook } from "./system/shutdown.ts"
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
import { makeBudgetPools } from "./usage/budget-pools.ts"
import { makeCostCeiling } from "./usage/cost-ceiling.ts"
import { type KeyUsage, makeKeyUsageReport } from "./usage/key-usage-report.ts"
import { makeLatencyReport } from "./usage/latency-report.ts"
import { makeMetricsExposition } from "./usage/metrics-exposition.ts"
import { makeModelCostComparison } from "./usage/model-cost-comparison.ts"
import { type ConnectionUsage, makeConnectionUsage } from "./usage/read-connection-usage.ts"
import { makeUsageReports } from "./usage/report-usage.ts"
import { makeSpendAnomalies } from "./usage/spend-anomaly.ts"
import { makeSpendForecast } from "./usage/spend-forecast.ts"
import { makeUsagePanels, type UsagePanels } from "./usage/usage-panels.ts"
import type { UseCasesCoreA } from "./use-cases-core-a.ts"

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

export interface UseCasesCoreB {
	/** The scheduled backup, as the settings screen reads and edits it. */
	readonly autoBackup: {
		readonly read: () => Promise<import("./settings/manage-auto-backup.ts").BackupView>
		readonly write: (
			body: Record<string, unknown>,
		) => Promise<import("./settings/manage-auto-backup.ts").BackupView>
		readonly sendNow: (input: {
			readonly action: unknown
			readonly password: string | null
		}) => Promise<{ ok: true; sizeBytes: number; channel: string } | { ok: false; error: string }>
	}
	/** Whole-install export and import, synchronous and as a polled job. */
	readonly database: {
		readonly read: (input: import("./settings/manage-database.ts").DatabaseInput) => Promise<unknown>
		readonly write: (input: {
			readonly body: Record<string, unknown>
			readonly credentials: import("./settings/manage-database.ts").DatabaseCredentials
		}) => Promise<{ success: true }>
		readonly startJob: (input: {
			readonly body: Record<string, unknown>
			readonly credentials: import("./settings/manage-database.ts").DatabaseCredentials
			readonly contentLength: string | null
		}) => Promise<import("./settings/manage-database.ts").StartedJob>
		readonly readJob: (input: {
			readonly jobId: string
			readonly credentials: import("./settings/manage-database.ts").DatabaseCredentials
		}) => Promise<import("../domain/database-access.ts").ImportJobProgress>
	}
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
	/** Importing provider credentials the operator already holds. */
	readonly credentials: {
		readonly importBatch: (input: {
			readonly provider: string
			readonly body: unknown
		}) => Promise<import("../domain/oauth-import.ts").BulkImportAnswer>
		readonly autoImport: (
			provider: string,
		) => Promise<import("../domain/oauth-local-credential.ts").CredentialSearch<unknown>>
		readonly autoImportCursor: () => Promise<import("./oauth/auto-import.ts").CursorImport>
		readonly importToken: (
			provider: string,
			body: unknown,
		) => Promise<import("./oauth/import-token.ts").ImportAnswer>
		/** A long-lived key: kiro's bearer key, or MiMo's key-or-session. */
		readonly importApiKey: (provider: string, body: unknown) => Promise<ApiKeyAnswer>
	}
	/**
	 * The OAuth login dispatcher's session actions.
	 *
	 * Separate from `credentials` because these drive a login that is still in flight — a
	 * session the browser is polling, a proxy to stop — rather than a credential being stored.
	 */
	readonly oauth: {
		/**
		 * The caller's headers decide which fetch verifies the PAT: remote goes through the
		 * SSRF guard, local may reach a self-hosted instance. Passing the headers rather
		 * than a fetch keeps that rule in this layer, where it cannot be skipped by a new
		 * caller.
		 */
		readonly importGitlabPat: (body: unknown, headers: Headers) => Promise<GitlabPatAnswer>
		readonly importIflowCookie: (body: unknown, headers: Headers) => Promise<IflowCookieAnswer>
		readonly readMimoRegion: (body: unknown) => MimoRegion
		/**
		 * MiMo's login start stays a host concern: it walks two redirect hops while carrying
		 * a session cookie the host mints, and the answer sets that cookie. The cookie is a
		 * credential the browser must receive, not a value a procedure may return, so this
		 * one is not a procedure — see the note in `routers/oauth.ts`.
		 */
		readonly startMimoLogin: (body: unknown, host: MimoLoginStartDeps) => Promise<MimoLoginStarted>
		readonly authorizeKiroSocial: (provider: string | null) => KiroSocialAnswer
		readonly exchangeKiroSocial: (body: unknown) => Promise<KiroSocialAnswer>
		readonly importKiroCliAuth: (
			body: unknown,
		) => Promise<import("./oauth/import-kiro-cli-auth.ts").KiroImportOutcome>
		readonly pollSession: (provider: string, state: string | null) => Promise<DispatchAnswer>
		readonly stopProxy: (provider: string) => DispatchAnswer
		readonly ideStatus: (provider: string) => Promise<DispatchAnswer>
	}
}
