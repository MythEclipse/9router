/**
 * Fill the Codex identity fields a pasted token did not carry.
 *
 * An export from another install often has the token and nothing else; the email, account
 * id and plan are all inside the token's own claims. Reading them here is what makes an
 * imported connection recognisable in the dashboard instead of a nameless row.
 */
function backfillCodex(item: Record<string, unknown>): Record<string, unknown> {
	const filled = { ...item }
	const psd = { ...((filled.providerSpecificData as Record<string, unknown> | undefined) ?? {}) }
	const needsEmail = !filled.email
	const needsAccountId = !psd.chatgptAccountId
	const needsPlanType = !psd.chatgptPlanType
	if (!needsEmail && !needsAccountId && !needsPlanType) return filled

	const raw = filled.idToken ?? filled.accessToken
	const info = (typeof raw === "string" ? extractCodexAccountInfo(raw) : null) ?? {}
	if (needsEmail && info.email) filled.email = info.email
	if (needsAccountId && info.chatgptAccountId) psd.chatgptAccountId = info.chatgptAccountId
	if (needsPlanType && info.chatgptPlanType) psd.chatgptPlanType = info.chatgptPlanType
	if (Object.keys(psd).length > 0) filled.providerSpecificData = psd
	return filled
}

/**
 * The process-wide use-case graph.
 *
 * Built once, on first use. Constructing it opens the SQLite handle and runs
 * migrations, so doing it at module import would run migrations during a Next
 * build. Next reloads route modules per request in development, so the instance
 * is cached on `globalThis` — a module-level variable would open a new database
 * handle on every hot reload until the process ran out of file descriptors.
 */

import { existsSync } from "node:fs"
import { creatorNameFor, visibleApiKeys } from "@9router/auth/keyCreator"
import { closeDb, getAdapter } from "@9router/db/driver"
import { matchesAnyModelName } from "@9router/db/repos/allowedModels"
import { getApiKeyById, parseAllowedModels } from "@9router/db/repos/apiKeysRepo"
import {
	getDistinctProviders,
	getRequestDetailById,
	getRequestDetails,
} from "@9router/db/repos/requestDetailsRepo"
import { getPricingForModel } from "@9router/pricing"
import type { UseCases } from "9router-api/application/use-cases"
import {
	authExpiryVerdict,
	canReadConnectionUsage,
	customQuotaConnection,
	quotaProxyOptions,
	refreshFailureMessage,
} from "9router-api/domain/connection-usage"
import { AppError } from "9router-api/domain/errors"
import {
	isPageFailure,
	readRequestDetailsPage,
	redactionSettingsFrom,
	redactRequestDetail,
	shouldIncludePayloads,
} from "9router-api/domain/observability"
import {
	createUseCases,
	installPxpipeEngine,
	installSemanticCacheModule,
} from "9router-api/infrastructure/use-cases-factory"
import { fetchElevenLabsVoices, VOICE_FETCHERS } from "open-sse/handlers/ttsCore"
import { getSemanticCacheStats, resetSemanticCacheStats } from "open-sse/rtk/semanticCache"
import { getTokenSavingsReport } from "open-sse/rtk/tokenSaverStats"
import { modelIdSpellings } from "open-sse/services/model"
import { getUsageForProvider } from "open-sse/services/usage"
import { isCustomQuotaProvider } from "open-sse/services/usage/customCredits"
import { isLocalHeaders } from "@/dashboardGuard"
import {
	DEFAULT_HEADROOM_URL,
	findPython310,
	getHeadroomStatus,
	getInstalledHeadroomExtras,
	HEADROOM_COMPRESSION_EXTRAS,
	isLoopbackHeadroomUrl,
} from "@/lib/headroom/detect"
import {
	getInstallLogTail as getHeadroomInstallLogTail,
	getManagedPid,
	installHeadroomExtras,
	restartHeadroomProxy,
	startHeadroomProxy,
	stopHeadroomProxy,
	uninstallHeadroomExtras,
} from "@/lib/headroom/process"
import { extractCodexAccountInfo } from "@/lib/oauth/providerHelpers"
import { KiroService } from "@/lib/oauth/services/kiro"
import { generatePKCE } from "@/lib/oauth/utils/pkce"
import {
	createProviderConnection,
	getProviderConnections,
	updateProviderConnection,
} from "@/models"
import {
	AI_PROVIDERS,
	getProviderByAlias,
	USAGE_APIKEY_PROVIDERS,
} from "@/shared/constants/providers"
import { fetchPublic } from "@/shared/utils/ssrfGuard"
import { createApiKeyStore } from "./apiKeyStore"
import { killAppProcesses } from "./appProcessManager"
import { createAutoBackupDeps } from "./autoBackupHost"
import { createComboPresetPort } from "./comboPresetPort"
import { createDatabaseDeps } from "./databaseHost"
import {
	cancelProxyImportJob,
	createProxyImportJob,
	getProxyImportJob,
	listProxyImportJobs,
} from "./db/proxyImportJobs"
import {
	getApiKeys,
	getProviderConnectionById,
	getProviderNodeById,
	getProviderNodes,
	getSettings,
} from "./localDb"
import {
	catalogueHost,
	knownSttTransport,
	probeBaseUrl,
	registryHost,
	resolveProviderAlias,
	studioCycleRefusal,
} from "./modelRegistryHost"
import { resolveConnectionProxyConfig } from "./network/connectionProxy"
import {
	API_KEY_CHECKS,
	AUTO_IMPORT_HOSTS,
	type AutoImportProvider,
	cursorImportDeps,
	TOKEN_VERIFIERS,
} from "./oauthImportHost"
import { oauthSessionDeps } from "./oauthSessionHost"
import { clearPluginCache } from "./plugins/customPluginsRuntime"
import {
	aiProviderEntry,
	armCatalogueSyncer,
	backfillConnectionEmails,
	batchClassifiers,
	clientListingRegistry,
	commandCodeBody,
	commandCodeHeaders,
	connectionHost,
	connectionResponse,
	defaultModelOf,
	fetchCatalogueUrl,
	fetchConnectionModels,
	fetchKiloCatalogue,
	findSyncableCatalogue,
	freeModelCache,
	isSerialProbe,
	normalizeProviderId,
	normalizeProviderSpecificData,
	ollamaLocalHost,
	probeAwsCredentials,
	probeConnection,
	probeModel,
	probeNousKey,
	probeQoderCredentials,
	probeTargetsFor,
	providerAliasOf,
	providerCatalogue,
	providerEntry,
	providerOverrides,
	readSyncedCatalogue,
	refreshSyncedCatalogue,
	sendProbe,
	suggestedCatalogue,
	tokenplanBaseUrl,
	webLogin,
} from "./providerConnectionHost"
import { fetchModels, resolveCustomModels } from "./providerModelsHost"
import { getPxpipeStats, readPxpipeEvents } from "./pxpipe/events"
import { getInstallInfo, getInstallLogTail, installPxpipe } from "./pxpipe/install"
import { loadPxpipe, unloadPxpipe } from "./pxpipe/loader"
import { getPxpipeStatus, runHealthCheck } from "./pxpipe/service"
import { createDeployDeps } from "./relayDeployHost"
import {
	settingsHistoryHost,
	settingsPassword,
	settingsStore,
	settingsWriteBack,
} from "./settingsHost"
import {
	createTailscaleCheckDeps,
	createTailscaleInstallDeps,
	createTunnelProbeDeps,
	createTunnelToggleDeps,
} from "./tunnelHost"
import { buildAvailableModels } from "./usage/availableModelsHost"
import { refreshAndUpdateCredentials } from "./usage/connectionRefresh"
import { budgetOf, spentTodayOf, todayKey } from "./usage/keyBudget"

// This host is the one that bundles `open-sse` and `lib/pxpipe`, so it is the one
// that can answer those ports. Without this they would report empty results.
installSemanticCacheModule({
	getSemanticCacheStats,
	resetSemanticCacheStats,
})

installPxpipeEngine({
	getPxpipeStatus,
	getInstallInfo,
	installPxpipe,
	loadPxpipe,
	unloadPxpipe,
	runHealthCheck,
	getPxpipeStats,
	readPxpipeEvents,
	getInstallLogTail,
})

const CACHE_KEY = Symbol.for("9router.useCases")

/**
 * Where the migration journal is, or `undefined` to let the migrator search.
 *
 * `undefined` is the honest answer when nothing staged a journal: the migrator
 * then ascends from its own location and finds `apps/api/migrations` in a dev
 * tree. Handing it a path that does not exist makes it stop and refuse, which is
 * how every database-backed route came to answer 500 under `bun run dev`.
 *
 * A standalone build stages `migrations/` beside the server and sets nothing, so
 * the same ascent finds that copy too.
 */
function resolveMigrationsDir(): string | undefined {
	const configured = process.env.MIGRATIONS_DIR
	if (!configured) return undefined
	return existsSync(configured) ? configured : undefined
}

interface Cache {
	readonly useCases: UseCases
}

function cache(): Cache {
	const scope = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache }
	if (!scope[CACHE_KEY]) {
		const { useCases } = createUseCases({
			dataDir: process.env.DATA_DIR,
			webAppDir: process.cwd(),
			gatewayUrl: process.env.GATEWAY_URL,
			onRotationError: (error) => console.warn("combo rotation reset failed:", error),
			comboPresets: createComboPresetPort(),
			apiKeyStore: createApiKeyStore(),
			// The settings row is one table: its password hashing, its history and the
			// process state a write owes all live in this process.
			settingsPassword,
			settingsWriteBack,
			settingsStore,
			autoBackup: createAutoBackupDeps(),
			database: createDatabaseDeps(),
			settingsHistory: settingsHistoryHost,
			// The dashboard is the process that holds the plugin runtime, so it is
			// the one that can invalidate the cached configuration.
			pluginCache: { clear: clearPluginCache },
			// ...and the one that owns the managed background processes, so shutdown
			// stops them here rather than leaving orphans behind.
			stopManagedProcesses: killAppProcesses,
			// The dashboard's database is the shared driver, not the handle the
			// factory opened, so it is closed through the driver's own entry point.
			closeDatabase: closeDb,
			// Deploying a relay calls the provider's own HTTP API; this host has the network.
			relayDeploy: createDeployDeps(),
			// Importing a credential writes one row; the batch rules live in the use-case.
			createProviderConnection: (input) => createProviderConnection(input),
			// A client-supplied base URL (GitLab PAT, iflow) must pass the SSRF guard for a
			// remote caller, while a local one keeps a self-hosted instance reachable.
			fetchForCaller: (headers) => (isLocalHeaders(headers) ? globalThis.fetch : fetchPublic),
			// Headroom runs as a child of this process, so its lifecycle — and the python it
			// needs — only exists on a host with a machine.
			headroom: {
				defaultUrl: DEFAULT_HEADROOM_URL,
				isLoopback: isLoopbackHeadroomUrl,
				start: (options) => startHeadroomProxy(options),
				restart: (options) => restartHeadroomProxy(options),
				stop: () => stopHeadroomProxy(),
				detect: (url) => getHeadroomStatus(url),
				managedPid: () => getManagedPid(),
				findPython: () => findPython310(),
				installedExtras: (python) => getInstalledHeadroomExtras(python),
				availableExtras: HEADROOM_COMPRESSION_EXTRAS,
				installExtras: (extras) => installHeadroomExtras([...extras]),
				uninstallExtras: (extras) => uninstallHeadroomExtras([...extras]),
				installLogTail: (maxLines) => getHeadroomInstallLogTail(maxLines),
				readSettings: () => getSettings(),
			},
			// The voice pickers read one stored connection per provider and reshape whatever
			// payload the provider answers; both live outside this layer.
			ttsVoices: {
				connectionOf: async (provider) => {
					const connections = await getProviderConnections({ provider, isActive: true })
					return connections[0] as { apiKey?: string } | undefined
				},
				fetchVoices: (provider, apiKey) =>
					VOICE_FETCHERS[provider as keyof typeof VOICE_FETCHERS](apiKey),
				fetchElevenLabs: (apiKey) => fetchElevenLabsVoices(apiKey),
				fetchImpl: globalThis.fetch,
				providers: Object.keys(VOICE_FETCHERS),
			},
			// Per-key usage: the key list and the three folding rules are host concerns (the
			// visibility rule reads the auth payload, the budget rules read the key rows), while
			// the aggregates come from the shared database in the factory.
			keyUsage: {
				listKeys: async () => (await getApiKeys()) as never,
				visibleKeys: (keys, session) => visibleApiKeys([...keys], session) as never,
				creatorNameOf: (createdBy, keys) => creatorNameFor({ createdBy, keys: [...keys] }) ?? undefined,
				budgetOf: (key, context) =>
					budgetOf(key as never, context as never) as { kind: string; cap: number; used: number },
				spentTodayOf: (key) => spentTodayOf(key as never),
				todayKey,
				// A key is a credential: only a prefix is ever rendered, and never in a log line.
				maskKey: (key) =>
					!key || typeof key !== "string"
						? ""
						: key.length <= 10
							? key.slice(0, 4) + "***"
							: key.slice(0, 10) + "***",
				now: () => Date.now(),
			},
			// Preflight for a spending ceiling: the budget comes from the same folding rules the
			// key list renders, and the rates from the pricing table the cost column uses.
			costCeiling: {
				budgetOf: async (keyId: string) => {
					const key = (await getApiKeyById(keyId)) as never
					if (!key) return null
					const today = todayKey()
					return budgetOf(key, {
						tokenCap: (key as { tokenLimit?: number }).tokenLimit,
						tokenUsed: spentTodayOf(key),
						today,
					} as never) as { kind: string; cap: number; used: number }
				},
				ratesOf: (provider: string, model: string) => getPricingForModel(provider, model) as never,
			},
			// The remaining panels: mostly static tables this process owns (the model catalogue,
			// the provider aliases) plus the open-sse rollup that only it can reach.
			usagePanels: {
				admitsModel: (allowedModels, model) =>
					matchesAnyModelName(parseAllowedModels(allowedModels || "*"), modelIdSpellings(model)),
				distinctProviders: (allowedModels) =>
					getDistinctProviders(parseAllowedModels(allowedModels || "*")),
				providerLabels: async () => ({
					nodes: Object.fromEntries(
						(await getProviderNodes()).map((node) => [node.id, { name: node.name, logo: node.logo }]),
					),
					catalogueOf: (id) => getProviderByAlias(id) || AI_PROVIDERS[id],
				}),
				tokenSavings: (period) => getTokenSavingsReport(getAdapter() as never, period),
				availableModels: (scope) =>
					buildAvailableModels({
						allowedModels: scope.allowedModels,
						isApiKey: scope.isApiKey,
					}),
				requestDetails: async ({ query, scope, requestAuthenticated }) => {
					const paging = readRequestDetailsPage({ page: query.page, pageSize: query.pageSize })
					if (isPageFailure(paging)) {
						throw new AppError("VALIDATION", paging.error, { status: paging.status })
					}
					const filter: Record<string, unknown> = {
						page: paging.page.page,
						pageSize: paging.page.pageSize,
						allowedModelPatterns: parseAllowedModels(scope.allowedModels || "*"),
					}
					for (const field of [
						"provider",
						"model",
						"connectionId",
						"status",
						"startDate",
						"endDate",
					] as const) {
						if (query[field]) filter[field] = query[field]
					}

					const result = await getRequestDetails(filter)
					let includePayloads = false
					try {
						const read = redactionSettingsFrom((await getSettings()) as never)
						includePayloads = shouldIncludePayloads({
							settings: read.settings,
							requireLoginDisabled: read.requireLoginDisabled,
							requestAuthenticated: read.requireLoginDisabled ? requestAuthenticated : false,
						}).include
					} catch {
						// Fail closed: an unreadable settings row must not reveal payloads.
						includePayloads = false
					}

					const details = (result.details || []).map((detail) =>
						redactRequestDetail(detail as Record<string, unknown>, includePayloads),
					)
					return { ...result, details, payloadsIncluded: includePayloads }
				},
				requestDetailById: (id) => getRequestDetailById(id),
			},
			// One connection's own quota. The refresh path is the one in this file's sibling
			// module, exported precisely so this and codex-reset-credits cannot drift on it.
			connectionUsage: {
				connectionOf: (id) => getProviderConnectionById(id),
				nodeOf: (provider) => getProviderNodeById(provider),
				usageApiKeyProviders: USAGE_APIKEY_PROVIDERS,
				isCustomQuotaProvider,
				isOAuthConnection: (connection) =>
					connection.authType === "oauth" || Boolean(connection.refreshToken),
				canReadConnectionUsage,
				customQuotaConnection,
				quotaProxyOptions,
				proxyConfigOf: (data) => resolveConnectionProxyConfig(data as never),
				authExpiryVerdict,
				refreshFailureMessage,
				refresh: (connection, force, proxyOptions) =>
					refreshAndUpdateCredentials(connection as never, force, proxyOptions as never),
				usageOf: (connection, proxyOptions, options) =>
					getUsageForProvider(connection as never, proxyOptions as never, options as never),
			},
			kiroSocial: {
				authorize: {
					generatePkce: generatePKCE,
					buildLoginUrl: (provider, codeChallenge, state) =>
						new KiroService().buildSocialLoginUrl(provider, codeChallenge, state),
				},
				exchange: {
					// The redirect URI is Kiro's own callback; the service already knows it.
					exchangeCode: (code, codeVerifier) => new KiroService().exchangeSocialCode(code, codeVerifier),
					emailFromToken: (accessToken) => new KiroService().extractEmailFromJWT(accessToken),
					now: () => Date.now(),
				},
			},
			credentialImport: {
				codex: { authType: "oauth", backfill: backfillCodex },
				"grok-cli": { authType: "oauth", backfill: (item) => item },
			},
			localCredentials: Object.fromEntries(
				(Object.keys(AUTO_IMPORT_HOSTS) as AutoImportProvider[]).map((provider) => [
					provider,
					AUTO_IMPORT_HOSTS[provider](),
				]),
			),
			// Cursor's read is a ladder, not one lookup, so it gets its own port.
			cursorImport: cursorImportDeps(),
			tokenVerify: TOKEN_VERIFIERS,
			apiKeyCheck: API_KEY_CHECKS,
			// MiMo re-imports over the row it already made, so it can see an account twice
			// without the dashboard offering it twice.
			findConnection: async ({ key, uid, sessionOnly, mimoUserId, region }) => {
				const existing = (await getProviderConnections()).find(
					(c) =>
						c.provider === "xiaomi-mimo" &&
						((uid && c.email === `${uid}@xiaomi`) ||
							(key && c.accessToken === key) ||
							(sessionOnly &&
								mimoUserId &&
								c.providerSpecificData?.mimoUserId === mimoUserId &&
								(region ? (c.providerSpecificData?.region || "cn") === region : true))),
				)
				return existing ? { id: existing.id, provider: existing.provider, email: existing.email } : null
			},
			updateConnection: (id, patch) => updateProviderConnection(id, patch),
			oauthSession: oauthSessionDeps(),
			newSystemId: () => crypto.randomUUID(),
			// The tunnel verbs touch a process, a socket and a package manager; only this host can.
			tunnelProbes: createTunnelProbeDeps(),
			tunnelToggle: createTunnelToggleDeps(),
			tailscaleCheck: createTailscaleCheckDeps(),
			tailscaleInstall: createTailscaleInstallDeps(),
			// The import jobs run in this process and outlive the browser that started them.
			proxyImportJobs: {
				create: (entries) => createProxyImportJob(entries),
				find: (id) => getProxyImportJob(id) ?? null,
				list: () => listProxyImportJobs(),
				cancel: (id) => cancelProxyImportJob(id),
			},
			// Turbopack rewrites import.meta.url in a build, so the migrator cannot
			// always find the journal on its own; copy-standalone-assets.mjs stages it
			// at <server cwd>/migrations, and a process started from another directory
			// (the oRPC server) passes MIGRATIONS_DIR.
			//
			// Passing a path that does not exist is worse than passing none: the
			// migrator checks an explicit path and stops, never trying its own ascent.
			// That made `bun run dev` fail every database-backed route with "Migration
			// journal not found at apps/web/migrations" — a directory that only exists
			// in a standalone build. An absent path now falls through to the search.
			migrationsDir: resolveMigrationsDir(),
			// The model registries and the capability tables live in this
			// directory, so this process is the one that can answer for them.
			registryHost,
			catalogueHost,
			// The connection tables and the provider catalogue live here too.
			connectionHost,
			providerCatalogue,
			connectionResponse,
			normalizeProviderId,
			normalizeProviderSpecificData,
			providerOverrides,
			freeModelCache,
			fetchKiloCatalogue,
			probeTargetsFor,
			providerAliasOf,
			fetchConnectionModels,
			probeModel,
			isSerialProbe,
			batchClassifiers,
			clientListingRegistry,
			probeConnection,
			backfillConnectionEmails,
			fetchModels,
			resolveCustomModels,
			suggestedCatalogue,
			findSyncableCatalogue,
			readSyncedCatalogue,
			refreshSyncedCatalogue,
			fetchCatalogueUrl,
			armCatalogueSyncer,
			sendProbe,
			defaultModelOf,
			providerEntry,
			aiProviderEntry,
			probeAwsCredentials,
			probeQoderCredentials,
			probeNousKey,
			ollamaLocalHost,
			tokenplanBaseUrl,
			commandCodeBody,
			commandCodeHeaders,
			webLogin,
			findStudioCycle: studioCycleRefusal,
			resolveProviderAlias,
			knownSttTransport,
			probeBaseUrl,
		})
		scope[CACHE_KEY] = { useCases }
	}
	return scope[CACHE_KEY]
}

export function getUseCases(): UseCases {
	return cache().useCases
}
