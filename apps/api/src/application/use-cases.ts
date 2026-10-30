/**
 * Composition of every use-case over one `Dependencies` graph.
 *
 * The single place that knows which use-case exists. Routers receive this
 * object, never the database, so wiring stays centralised and a test can build
 * the same shape from fakes.
 */

import type { ClaudeResetOutcome } from "../domain/claude-reset.ts"
import { invalid } from "../domain/errors.ts"
import type { MimoRegion } from "../domain/mimo-login.ts"
import { readMimoRegion } from "../domain/mimo-login.ts"
import { makeBulkEditApiKeys } from "./api-keys/bulk-edit-api-keys.ts"
import { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
import { makeManageApiKeys } from "./api-keys/manage-api-keys-dashboard.ts"
import { makeManageSingleKey } from "./api-keys/manage-single-key.ts"
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
import { makeModelCatalogue } from "./models/list-models.ts"
import { makeCustomModels, makeModelAliases } from "./models/manage-aliases.ts"
import { makeModelAvailability } from "./models/manage-availability.ts"
import { makeCatalogueSync, makeModelProbe } from "./models/manage-catalogue-sync.ts"
import { makeBaseUrlValidation, makeDisabledModels } from "./models/manage-disabled-models.ts"
import { makeProviderNodes } from "./models/manage-provider-nodes.ts"
import { makeStudioModels } from "./models/manage-studio-models.ts"
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
import { type KeyUsage, makeKeyUsageReport } from "./usage/key-usage-report.ts"
import { type ConnectionUsage, makeConnectionUsage } from "./usage/read-connection-usage.ts"
import { makeUsageReports } from "./usage/report-usage.ts"
import { makeUsagePanels, type UsagePanels } from "./usage/usage-panels.ts"

export interface UseCases {
	readonly createApiKey: ReturnType<typeof makeCreateApiKey>
	readonly listApiKeys: ReturnType<typeof makeListApiKeys>
	readonly revokeApiKey: ReturnType<typeof makeRevokeApiKey>
	/** The dashboard's key table: list, create with scoping, bulk edit. */
	readonly dashboardKeys: ReturnType<typeof makeManageApiKeys>
	readonly bulkEditKeys: ReturnType<typeof makeBulkEditApiKeys>
	readonly singleKey: ReturnType<typeof makeManageSingleKey>
	/** The read-only usage endpoints: stats, chart, sparks, logs, history. */
	readonly usageReports: ReturnType<typeof makeUsageReports>
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

export function buildUseCases(deps: Dependencies): UseCases {
	const combos = comboDeps(deps)
	return {
		createApiKey: makeCreateApiKey(deps),
		listApiKeys: makeListApiKeys(deps),
		revokeApiKey: makeRevokeApiKey(deps),
		dashboardKeys: makeManageApiKeys({
			keys: deps.dashboardApiKeys,
			audit: deps.apiKeyAudit,
			matchesAllowedModels: deps.matchesAllowedModels,
			endpointKinds: deps.endpointKinds,
		}),
		bulkEditKeys: makeBulkEditApiKeys({
			keys: deps.bulkApiKeys,
			audit: deps.apiKeyAudit,
		}),
		usageReports: makeUsageReports({ usage: deps.usageReports }),
		singleKey: makeManageSingleKey({
			keys: deps.singleApiKeys,
			audit: deps.singleKeyAudit,
			endpointKinds: deps.endpointKinds,
			matchesAllowedModels: deps.matchesAllowedModels,
			defaultPermissions: { viewUsage: true, manageApiKeys: false },
		}),
		getChangelog: () => loadChangelog(deps.changelog),
		getLoginGate: () => readLoginGate(deps.settings),
		listCombos: makeListCombos(combos),
		createCombo: makeCreateCombo(combos),
		getCombo: makeGetCombo(combos),
		updateCombo: makeUpdateCombo(combos),
		deleteCombo: makeDeleteCombo(combos),
		duplicateCombo: makeDuplicateCombo(combos),
		checkComboCycle: makeCheckComboCycle(combos),
		previewComboPresets: makePreviewComboPresets(combos),
		createComboPresets: makeCreateComboPresets(combos),
		listErrorLogs: makeListErrorLogs(deps.errorLogs),
		clearErrorLogs: makeClearErrorLogs(deps.errorLogs),
		settings: makeManageSettings({
			store: deps.settingsStore,
			...deps.settingsPassword,
			...deps.settingsWriteBack,
		}),
		proxyPools: {
			list: (query) => listProxyPools(query, deps.proxyPools),
			create: (body) => createProxyPool(body, deps.proxyPools),
			read: (id) => readProxyPool(id, deps.proxyPools),
			update: (id, body) => updateProxyPool(id, body, deps.proxyPools),
			remove: (id) => deleteProxyPool(id, deps.proxyPools),
			bulkRemove: (body) => bulkDeleteProxyPools(body, deps.proxyPools),
			test: (id) => testProxyPool(id, deps.proxyPools),
			deploy: (provider, body) => deployRelay({ provider, body }, deps.relayDeploy),
			importJobs: {
				start: (body) => startProxyImport(body, deps.proxyImportJobs),
				read: (query) => readProxyImportJobs(query, deps.proxyImportJobs),
				cancel: (query) => cancelProxyImport(query, deps.proxyImportJobs),
			},
		},
		autoBackup: {
			read: () => readAutoBackup(deps.autoBackup),
			write: (body) => writeAutoBackup(body, deps.autoBackup),
			sendNow: (input) => sendAutoBackupNow(input, deps.autoBackup),
		},
		database: {
			read: (input) => readDatabase(input, deps.database),
			write: (input) => writeDatabase(input, deps.database),
			startJob: (input) => startDatabaseJob(input, deps.database),
			readJob: (input) => readDatabaseJob(input, deps.database),
		},
		settingsHistory: makeSettingsHistory({
			history: deps.settingsHistory.history,
			sanitize: deps.settingsHistory.sanitize,
			recordSecurityEvent: deps.settingsHistory.recordSecurityEvent,
			redact: deps.settingsHistory.redact,
			settings: deps.settingsStore,
			snapshot: async (before, actor, reason) => deps.settingsWriteBack.snapshot(before, reason),
		}),
		getTheme: makeGetTheme(deps.settings),
		setTheme: makeSetTheme(deps.settings),
		assertLocale: assertSupportedLocale,
		getPricing: makeGetPricing(deps.pricing),
		updatePricing: makeUpdatePricing(deps.pricing),
		resetPricing: makeResetPricing(deps.pricing),
		readPlugins: makeReadPlugins(deps.plugins, deps.pluginCatalogue),
		writePlugins: makeWritePlugins(deps.plugins, deps.pluginCatalogue, deps.pluginCache),
		cacheStats: makeCacheStats(deps.semanticCache),
		dashboardJobs: makeDashboardJobs(deps.dashboardJobRegistry, deps.dashboardJobEnv),
		shutdownFromDashboard: makeShutdownFromDashboard(deps.shutdown),
		shutdownFromHook: makeShutdownFromHook(deps.shutdown, deps.shutdownEnv),
		pxpipe: makePxpipe(deps.pxpipe, deps.pxpipeSettings),
		modelAliases: makeModelAliases({
			aliases: deps.modelAliases,
			reconciler: deps.allowedModelReconciler,
		}),
		overrides: makeOverrides({
			read: deps.providerOverrides.read,
			write: deps.providerOverrides.write,
			resolveAlias: deps.providerOverrides.resolveAlias,
			builtinHeaders: deps.providerOverrides.builtinHeaders,
		}),
		probeModels: makeProbeModels({
			connections: deps.connections,
			catalogue: deps.providerCatalogue,
			knownModels: deps.probeTargetsFor,
			aliasOf: deps.providerAliasOf,
			liveModels: deps.fetchConnectionModels,
			probe: deps.probeModel,
			isSerialProbe: deps.isSerialProbe,
		}),
		testConnections: makeTestConnections({
			connections: deps.connections,
			classifiers: deps.batchClassifiers,
			probe: deps.probeConnection,
			now: () => new Date().toISOString(),
		}),
		checkConnection: makeCheckConnection({ probe: deps.probeConnection }),
		listProviderModels: makeListProviderModels({
			connections: deps.connections,
			catalogue: deps.providerCatalogue,
			fetchModels: deps.fetchModels,
			resolveCustom: deps.resolveCustomModels,
		}),
		listClientConnections: makeListClientConnections({
			connections: deps.connections,
			nodes: deps.connectionNodes,
			registry: deps.clientListingRegistry,
			backfill: deps.backfillConnectionEmails,
		}),
		suggestModels: makeSuggestModels({
			catalogue: deps.suggestedCatalogue,
			findSyncable: deps.findSyncableCatalogue,
			readSynced: deps.readSyncedCatalogue,
			refreshSynced: deps.refreshSyncedCatalogue,
			fetchCatalogue: deps.fetchCatalogueUrl,
			armSyncer: deps.armCatalogueSyncer,
			timeoutMs: 12_000,
		}),
		validateCredential: makeValidateCredential({
			send: deps.sendProbe,
			findNode: async (provider) => deps.connectionNodes.find(provider),
			defaultModel: deps.defaultModelOf,
			providerConfig: deps.providerEntry,
			aiProvider: deps.aiProviderEntry,
			isOpenAICompatible: (provider) => deps.providerCatalogue.isOpenAICompatible(provider),
			isAnthropicCompatible: (provider) => deps.providerCatalogue.isAnthropicCompatible(provider),
			isCustomEmbedding: (provider) => deps.providerCatalogue.isCustomEmbedding(provider),
			probeAws: deps.probeAwsCredentials,
			probeQoder: deps.probeQoderCredentials,
			probeNous: deps.probeNousKey,
			ollamaLocalHost: deps.ollamaLocalHost,
			tokenplanBaseUrl: deps.tokenplanBaseUrl,
			commandCodeBody: deps.commandCodeBody,
			randomId: () => deps.randomId(),
		}),
		webLogin: makeWebLogin({
			...deps.webLogin,
			connections: deps.connections,
			providerLabel: (provider) => deps.providerCatalogue.label(provider),
		}),
		freeModels: makeFreeModels({
			fetchCatalogue: deps.fetchKiloCatalogue,
			cache: deps.freeModelCache,
			now: () => Date.now(),
		}),
		connections: makeConnections({
			connections: deps.connections,
			nodes: deps.connectionNodes,
			pools: deps.proxyPools,
			catalogue: deps.providerCatalogue,
			normalizeProviderId: deps.normalizeProviderId,
			normalizeProviderSpecificData: deps.normalizeProviderSpecificData,
			toResponse: deps.connectionResponse,
		}),
		customModels: makeCustomModels({
			models: deps.customModels,
			reconciler: deps.allowedModelReconciler,
			capabilityKeys: deps.modelCatalogue.capabilityKeys(),
			knownTransport: deps.knownSttTransport,
		}),
		disabledModels: makeDisabledModels({ disabled: deps.disabledModels }),
		studioModels: makeStudioModels({
			studios: deps.studioModels,
			combos: deps.comboReader,
			nodes: deps.nodePrefixes,
			reconciler: deps.allowedModelReconciler,
			resolveProviderAlias: deps.resolveProviderAlias,
			findCycle: deps.findStudioCycle,
		}),
		providerNodes: makeProviderNodes({
			nodes: deps.providerNodes,
			connections: deps.providerConnections,
			normalizeLogo: (value) => deps.modelCatalogue.normalizeLogo(value),
			generateId: () => deps.modelCatalogue.generateId(),
			prefixes: {
				openaiCompatible: "openai-compatible-",
				anthropicCompatible: "anthropic-compatible-",
				customEmbedding: "custom-embedding-",
			},
		}),
		modelCatalogue: makeModelCatalogue({
			catalogue: deps.modelCatalogue,
			aliases: deps.modelAliases,
			customModels: deps.customModels,
			studios: deps.studioModels,
			combos: deps.comboReader,
			disabledModels: deps.disabledModels,
			plugins: deps.pluginSettings,
		}),
		modelAvailability: makeModelAvailability({
			connections: deps.providerConnections,
			now: deps.now,
		}),
		catalogueSync: makeCatalogueSync({ sync: deps.catalogueSync }),
		modelProbe: makeModelProbe({ probe: deps.modelProbe }),
		baseUrlValidation: makeBaseUrlValidation({
			catalogue: deps.modelCatalogue,
			probeBaseUrl: (input) => deps.probeBaseUrl(input),
		}),

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
		ttsVoices: makeTtsVoices(deps.ttsVoices),
		keyUsage: makeKeyUsageReport(deps.keyUsage),
		usagePanels: makeUsagePanels(deps.usagePanels),
		connectionUsage: makeConnectionUsage(deps.connectionUsage),
	}
}
