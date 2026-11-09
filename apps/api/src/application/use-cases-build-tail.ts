/** Use-cases: tail slice. */
/** Use-cases: build function. */
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
import type { makeLatencyReport } from "./usage/latency-report.ts"
import { makeMetricsExposition } from "./usage/metrics-exposition.ts"
import { makeModelCostComparison } from "./usage/model-cost-comparison.ts"
import { type ConnectionUsage, makeConnectionUsage } from "./usage/read-connection-usage.ts"
import { makeUsageReports } from "./usage/report-usage.ts"
import { makeSpendAnomalies } from "./usage/spend-anomaly.ts"
import type { makeSpendForecast } from "./usage/spend-forecast.ts"
import type { makeUsagePanels, UsagePanels } from "./usage/usage-panels.ts"
import type { UseCasesCoreA } from "./use-cases-core-a.ts"
import type { UseCasesCoreB } from "./use-cases-core-b.ts"
import type { UseCasesExtra } from "./use-cases-extra.ts"
export type UseCases = UseCasesCoreA & UseCasesCoreB & UseCasesExtra

/** The combo use-cases share one dependency slice, so it is built once. */
function comboDeps(deps: Dependencies) {
	return {
		combos: deps.combos,
		studios: deps.studios,
		rotation: deps.comboRotation,
		presets: deps.comboPresets,
		strategies: deps.comboStrategies,
	}
}

/**
 * The probe cache, hung off `globalThis` so a Next hot reload reuses it.
 *
 * A module-level object would be re-created on every reload, so the cache would never hit
 * during development and every poll would probe the process again.
 */
function tunnelStatusCache(): TunnelStatusCache {
	const scope = globalThis as { __tunnelStatusCache?: TunnelStatusCache }
	scope.__tunnelStatusCache ??= { value: null, fetchedAt: 0 }
	return scope.__tunnelStatusCache
}

export interface TailShared {
	readonly usagePanels: ReturnType<typeof makeUsagePanels>
	readonly spendForecast: ReturnType<typeof makeSpendForecast>
	readonly latencyReport: ReturnType<typeof makeLatencyReport>
}
export function buildTailUseCases(deps: Dependencies, shared: TailShared) {
	const { usagePanels, spendForecast, latencyReport } = shared
	return {
		tunnel: {
			status: () => readTunnelStatus(tunnelStatusCache(), deps.tunnelProbes),
			enable: () => toggleTunnel({ kind: "cloudflare", on: true }, deps.tunnelToggle),
			disable: () => toggleTunnel({ kind: "cloudflare", on: false }, deps.tunnelToggle),
			tailscaleEnable: () => toggleTunnel({ kind: "tailscale", on: true }, deps.tunnelToggle),
			tailscaleDisable: () => toggleTunnel({ kind: "tailscale", on: false }, deps.tunnelToggle),
			tailscaleCheck: () => checkTailscale(deps.tailscaleCheck),
			tailscaleInstall: {
				prepare: (body) => prepareTailscaleInstall(body, deps.tailscaleInstall),
				run: (prepared, reportProgress) =>
					runTailscaleInstall(prepared, deps.tailscaleInstall, reportProgress),
			},
		},
		headroom: makeHeadroom(deps.headroom),
		authStatus: {
			read: (request) =>
				readAuthStatus({
					port: request.port,
					probes: request.probes,
					catalog: request.catalog,
					homePathFor: request.homePathFor,
					firstAllowedPage: request.firstAllowedPage,
					onFailure: request.onFailure,
				}),
		},
		ttsVoices: makeTtsVoices(deps.ttsVoices),
		keyUsage: makeKeyUsageReport(deps.keyUsage),
		usagePanels,
		metrics: makeMetricsExposition({
			panels: usagePanels,
			forecast: spendForecast,
			latency: latencyReport,
		}),
		latencyReport,
		spendAnomalies: makeSpendAnomalies(deps.spendAnomalies),
		auditLog: makeAuditLog({ port: deps.activity }),
		idempotency: makeIdempotency({ store: deps.idempotencyStore }),
		modelCost: makeModelCostComparison({ panels: usagePanels }),
		configExport: makeConfigExport(deps.configExportSources),
		budgetPools: makeBudgetPools(deps.budgetPoolStore),
		alertDispatch: makeDispatchAlerts(deps.alertPorts),
		replay: makeReplay(deps.replayPorts),
		explain: makeExplain({ byId: deps.replayPorts.byId, ratesOf: deps.costCeiling.ratesOf }),
		costCeiling: makeCostCeiling(deps.costCeiling),
		files: makeFiles(deps.fileStore),
		// ONE gate instance, shared with the batch runner. It used to be constructed a second
		// time here, which made `GET /api/queue` report a gate nobody ever entered: `inFlight`
		// was always 0 and the retry-after was always null.
		admission: deps.admissionGate,
		batches: makeBatches(deps.batchStore, deps.batchFiles, { gate: deps.admissionGate }),
		connectionUsage: makeConnectionUsage(deps.connectionUsage),
	}
}
