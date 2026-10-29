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
import { closeDb } from "@9router/db/driver"
import type { UseCases } from "9router-api/application/use-cases"
import {
	createUseCases,
	installPxpipeEngine,
	installSemanticCacheModule,
} from "9router-api/infrastructure/use-cases-factory"
import { getSemanticCacheStats, resetSemanticCacheStats } from "open-sse/rtk/semanticCache"
import { isLocalHeaders } from "@/dashboardGuard"
import { extractCodexAccountInfo } from "@/lib/oauth/providerHelpers"
import { KiroService } from "@/lib/oauth/services/kiro"
import { generatePKCE } from "@/lib/oauth/utils/pkce"
import {
	createProviderConnection,
	getProviderConnections,
	updateProviderConnection,
} from "@/models"
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
	catalogueHost,
	knownSttTransport,
	probeBaseUrl,
	registryHost,
	resolveProviderAlias,
	studioCycleRefusal,
} from "./modelRegistryHost"
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
