/** Use-cases: extra slice. */

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
import { makeModelCatalogue } from "./models/list-models.ts"
import { makeCustomModels, makeModelAliases } from "./models/manage-aliases.ts"
import { makeModelAvailability } from "./models/manage-availability.ts"
import { makeCatalogueSync, makeModelProbe } from "./models/manage-catalogue-sync.ts"
import { makeBaseUrlValidation, makeDisabledModels } from "./models/manage-disabled-models.ts"
import { makeProviderNodes } from "./models/manage-provider-nodes.ts"
import { makeStudioModels } from "./models/manage-studio-models.ts"
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
import type { AuthStatusRequest } from "./use-cases-core-a.ts"

export interface UseCasesExtra {
	/**
	 * Wiring a CLI tool to this install.
	 *
	 * One flow for every tool: is it installed, does it point here, put it here or take it
	 * away. What differs per tool is its config file, which the host supplies.
	 */
	readonly cliTools: {
		readonly readToolSettingsStatus: (host: ToolSettingsDeps) => Promise<ToolSettingsAnswer>
		readonly writeToolSettings: (body: unknown, host: ToolSettingsDeps) => Promise<ToolSettingsAnswer>
		readonly resetToolSettings: (host: ToolSettingsDeps) => Promise<ToolSettingsAnswer>
		readonly clearActiveModel: (config: ToolSettingsDeps["config"]) => Promise<ToolSettingsAnswer>
		readonly removeToolModel: (modelId: string, host: ToolSettingsDeps) => Promise<ToolSettingsAnswer>
		readonly readAllStatuses: (
			readers: Readonly<Record<string, () => Promise<Record<string, unknown>>>>,
		) => Promise<AllStatusesAnswer>
		/** Devin keeps its own credentials, so there is only detection to read. */
		readonly readDevinStatus: (
			install: DevinInstallPort,
			version: DevinVersionPort,
		) => Promise<DevinStatusAnswer>
	}
	/**
	 * Claude Code's settings screen, which speaks an `env` block rather than a provider entry
	 * and so does not share the CLI-tool flow above.
	 */
	readonly claudeTools: {
		readonly readSettingsStatus: (
			port: ClaudeSettingsPort,
			isInstalled: () => Promise<boolean>,
		) => Promise<ClaudeSettingsAnswer>
		readonly writeSettings: (
			body: unknown,
			port: ClaudeSettingsPort,
			options?: { exaMcpEnabled?: boolean },
		) => Promise<ClaudeSettingsAnswer>
		readonly resetSettings: (port: ClaudeSettingsPort) => Promise<ClaudeSettingsAnswer>
	}
	/** The operator's `~/.codex/*.config.toml` profiles. */
	readonly codexProfiles: {
		readonly list: (port: CodexProfilesPort) => Promise<CodexProfilesAnswer>
		readonly write: (body: unknown, port: CodexProfilesPort) => Promise<CodexProfilesAnswer>
		readonly remove: (body: unknown, port: CodexProfilesPort) => Promise<CodexProfilesAnswer>
	}
	/** The notification bell. */
	readonly notifications: {
		readonly read: (
			session: unknown,
			limit: unknown,
			store: NotificationStore,
		) => Promise<NotificationAnswer>
		readonly update: (
			session: unknown,
			body: unknown,
			store: NotificationStore,
		) => Promise<NotificationAnswer>
		readonly scan: (
			session: unknown,
			store: NotificationScanStore,
			wording: NoticeWording,
		) => Promise<ScanAnswer>
	}

	/** Codex's rate-limit reset credits. */
	readonly codexResetCredits: {
		readonly read: (connectionId: unknown, port: CodexResetPort) => Promise<CodexAnswer>
		readonly redeem: (connectionId: unknown, port: CodexResetPort) => Promise<CodexAnswer>
	}
	/**
	 * The dashboard's view of the current session.
	 *
	 * The port and the permission catalog are injected because they come from the host: the
	 * cookie, the settings table, and the permission paths live outside this graph.
	 */
	readonly authStatus: {
		readonly read: (deps: AuthStatusRequest) => Promise<AuthStatus>
	}
	/** Claude's limit-reset grant. */
	readonly claudeReset: {
		readonly spend: (
			connectionId: unknown,
			grantId: unknown,
			port: ClaudeResetPort,
		) => Promise<ClaudeResetOutcome>
	}
	/** The translator inspector's dump files. */
	readonly translator: {
		readonly load: (
			rawFile: unknown,
			safeName: DumpNameRule,
			store: TranslatorDumpStore,
		) => Promise<DumpAnswer>
		readonly save: (
			body: unknown,
			safeName: DumpNameRule,
			store: TranslatorDumpStore,
		) => Promise<DumpAnswer>
	}
	/** Claude Desktop's Cowork config library. */
	readonly coworkSettings: {
		readonly read: (deps: CoworkDependencies) => Promise<CoworkAnswer>
		readonly write: (body: unknown, deps: CoworkDependencies) => Promise<CoworkAnswer>
		readonly reset: (deps: CoworkDependencies) => Promise<CoworkAnswer>
	}
	/** Hermes Agent's per-profile YAML, and the bulk endpoint refresh. */
	readonly hermes: {
		readonly readSettings: (profile: unknown, port: HermesFilesPort) => Promise<HermesAnswer>
		readonly writeSettings: (body: unknown, port: HermesFilesPort) => Promise<HermesAnswer>
		readonly resetSettings: (body: unknown, port: HermesFilesPort) => Promise<HermesAnswer>
		readonly listProfiles: (port: HermesFilesPort) => Promise<{ profiles: HermesProfileSummary[] }>
	}
	/** Probing a Cowork MCP server for the tools it exposes. */
	readonly coworkMcp: {
		readonly probeTools: (
			body: unknown,
			options: {
				readonly fetchFor: ProbeFetch
				readonly allowPrivateUrl: boolean
				readonly assertPublicUrl: (url: string) => void
			},
		) => Promise<McpProbeAnswer>
		readonly readRegistry: (
			options: {
				readonly cache: RegistryCache
				readonly fetchServers: typeof fetch
				readonly now?: () => number
			},
			refresh: boolean,
		) => Promise<RegistryAnswer>
	}
	/** Cloudflare tunnels and Tailscale funnels, as the network screen drives them. */
	readonly tunnel: {
		readonly status: () => Promise<{ tunnel: unknown; tailscale: unknown; download: unknown }>
		readonly enable: () => Promise<unknown>
		readonly disable: () => Promise<unknown>
		readonly tailscaleEnable: () => Promise<unknown>
		readonly tailscaleDisable: () => Promise<unknown>
		readonly tailscaleCheck: () => Promise<import("../domain/tunnel.ts").TailscaleCheckAnswer>
		readonly tailscaleInstall: {
			readonly prepare: (body: Record<string, unknown>) => Promise<{
				password: string
				shortId: string
			}>
			readonly run: (
				prepared: { password: string; shortId: string },
				reportProgress: (message: string) => void,
			) => Promise<import("./tunnel/manage-tunnel.ts").InstallEvent>
		}
	}
	/** The Headroom proxy this install may run: lifecycle, status, and its extras. */
	readonly headroom: import("./headroom/manage-headroom.ts").HeadroomLifecycle
	/** The five TTS voice catalogues the pickers read. */
	readonly ttsVoices: TtsVoices
	/** One row per API key: quota state plus aggregates. */
	readonly keyUsage: KeyUsage
	/** Error classes, leaderboard, provider filter, token savings, model catalogue, details. */
	readonly usagePanels: UsagePanels
	/** One provider connection's own quota answer. */
	readonly connectionUsage: ConnectionUsage
}
