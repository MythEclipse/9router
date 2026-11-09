/** Use-cases: credentials & tools slice. */
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
import { makeLatencyReport } from "./usage/latency-report.ts"
import { makeMetricsExposition } from "./usage/metrics-exposition.ts"
import { makeModelCostComparison } from "./usage/model-cost-comparison.ts"
import { type ConnectionUsage, makeConnectionUsage } from "./usage/read-connection-usage.ts"
import { makeUsageReports } from "./usage/report-usage.ts"
import { makeSpendAnomalies } from "./usage/spend-anomaly.ts"
import { makeSpendForecast } from "./usage/spend-forecast.ts"
import { makeUsagePanels, type UsagePanels } from "./usage/usage-panels.ts"
import { buildEarlyUseCases } from "./use-cases-build-early.ts"
import { buildMidUseCases } from "./use-cases-build-mid.ts"
import type { UseCasesCoreA } from "./use-cases-core-a.ts"
import type { UseCasesCoreB } from "./use-cases-core-b.ts"
import type { UseCasesExtra } from "./use-cases-extra.ts"
export type UseCases = UseCasesCoreA & UseCasesCoreB & UseCasesExtra

import { buildTailUseCases } from "./use-cases-build-tail.ts"

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

export function buildCredUseCases(deps: import("./dependencies.ts").Dependencies) {
	return {
		credentials: {
			importBatch: async ({ provider, body }) => {
				const settings = deps.credentialImport[provider]
				if (!settings) throw invalid(`Unknown import provider: ${provider}`)
				return importCredentialBatch(
					{ provider, authType: settings.authType, body },
					{
						backfill: settings.backfill,
						create: deps.createProviderConnection,
						now: () => Date.now(),
					},
				)
			},
			autoImportCursor: () => autoImportCursor(deps.cursorImport),
			importToken: async (provider, body) => {
				// Codex reads its claims from the token itself; every other provider asks.
				// Codex reads its claims from the token itself; every other provider asks.
				const verify = needsRemoteVerification(provider)
					? deps.tokenVerify[provider]
					: async ({ accessToken }: { accessToken: string }) => ({ accessToken })
				return importAnswerOf(
					await importToken(provider, body, {
						verify,
						create: deps.createProviderConnection,
						now: () => deps.now().getTime(),
						newSystemId: deps.newSystemId,
					}),
				)
			},
			importApiKey: async (provider, body) => {
				const check = deps.apiKeyCheck[provider]
				if (!check) throw invalid(`Unknown api-key provider: ${provider}`)
				const host = {
					check,
					create: deps.createProviderConnection,
					now: () => deps.now().getTime(),
				}
				// MiMo can be re-imported over the row it already made; Kiro never looks.
				return provider === "xiaomi-mimo"
					? importMimoApiKey(body, {
							...host,
							findExisting: deps.findConnection,
							update: deps.updateConnection,
						})
					: importKiroApiKey(body, host)
			},
			autoImport: async (provider) => {
				const local = deps.localCredentials[provider]
				if (!local) throw invalid(`Unknown auto-import provider: ${provider}`)
				return autoImportLocalCredential({ provider }, local)
			},
		},
		oauth: {
			pollSession: (provider, state) => pollSessionStatus(provider, state, deps.oauthSession),
			stopProxy: (provider) => stopProviderProxy(provider, deps.oauthSession),
			ideStatus: (provider) => readIdeStatus(provider, deps.oauthSession),
			importGitlabPat: (body, headers) =>
				importGitlabPat(body, {
					fetchImpl: deps.fetchForCaller(headers),
					createConnection: deps.createProviderConnection,
				}),
			importIflowCookie: (body, headers) =>
				importIflowCookie(body, {
					fetchImpl: deps.fetchForCaller(headers),
					createConnection: deps.createProviderConnection,
				}),
			readMimoRegion: (body) => readMimoRegion(body),
			startMimoLogin: (body, host) => startMimoLogin(body, host),
			authorizeKiroSocial: (provider) => authorizeKiroSocial(provider, deps.kiroSocial.authorize),
			exchangeKiroSocial: (body) =>
				exchangeKiroSocial(body, {
					...deps.kiroSocial.exchange,
					createConnection: deps.createProviderConnection,
				}),
			importKiroCliAuth: (body) =>
				importKiroCliAuth(body, {
					...deps.kiroCliImport,
					createConnection: deps.createProviderConnection,
				}),
		},
		cliTools: {
			readToolSettingsStatus: (host) => readToolSettingsStatus(host),
			writeToolSettings: (body, host) => writeToolSettings(body, host),
			resetToolSettings: (host) => resetToolSettings(host),
			clearActiveModel: (config) => clearActiveModel(config),
			removeToolModel: (modelId, host) => removeToolModel(modelId, host),
			readAllStatuses: (readers) => readAllToolStatuses(readers),
			readDevinStatus: (install, version) => readDevinStatus(install, version),
		},
		claudeTools: {
			readSettingsStatus: (port, isInstalled) => readClaudeSettingsStatus(port, isInstalled),
			writeSettings: (body, port, options) => writeClaudeSettings(body, port, options),
			resetSettings: (port) => resetClaudeSettings(port),
		},
		codexProfiles: {
			list: (port) => listCodexProfiles(port),
			write: (body, port) => writeCodexProfile(body, port),
			remove: (body, port) => deleteCodexProfile(body, port),
		},
		notifications: {
			read: (session, limit, store) => readNotifications(session, limit, store),
			update: (session, body, store) => updateNotification(session, body, store),
			scan: (session, store, wording) => scanNotifications(session, store, wording),
		},
		codexResetCredits: {
			read: (connectionId, port) => readResetCredits(connectionId, port),
			redeem: (connectionId, port) => redeemResetCredit(connectionId, port),
		},
		claudeReset: {
			spend: (connectionId, grantId, port) => spendResetGrant(connectionId, grantId, port),
		},
		translator: {
			load: (rawFile, safeName, store) => loadDump(rawFile, safeName, store),
			save: (body, safeName, store) => saveDump(body, safeName, store),
		},
		coworkSettings: {
			read: (deps) => readCoworkSettings(deps),
			write: (body, deps) => writeCoworkSettings(body, deps),
			reset: (deps) => resetCoworkSettings(deps),
		},
		hermes: {
			readSettings: (profile, port) => readHermesSettings(profile, port),
			writeSettings: (body, port) => writeHermesSettings(body, port),
			resetSettings: (body, port) => resetHermesSettingsUseCase(body, port),
			listProfiles: (port) => listHermesProfiles(port),
		},
		coworkMcp: {
			probeTools: (body, options) => probeCoworkMcpTools(body, options),
			readRegistry: (options, refresh) => readMcpRegistry(options, refresh),
		},
		// The probe cache is process-wide and survives a hot reload, exactly like the module
		// scope it replaced: one cache per process, not one per request.
	}
}
