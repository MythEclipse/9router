import type { ApiKeyVerdict } from "@9router/db/repos/apiKeysRepo"
import type { ProviderConnectionRecord } from "@9router/db/repos/connectionsRepo"
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig"
import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import {
	buildModelLockUpdate,
	checkFallbackError,
	formatRetryAfter,
	getEarliestModelLockUntil,
	isModelLockActive,
	shouldRotateProxy,
} from "open-sse/services/accountFallback"
import {
	getProviderConnections,
	getProxyPools,
	getSettings,
	updateProviderConnection,
	validateApiKey,
} from "@/lib/localDb"
import { pickProxyPoolId, resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import { markProxyHealthy, markProxyUnhealthy } from "@/lib/network/proxyHealth"
import { FREE_PROVIDERS, resolveProviderId } from "@/shared/constants/providers"
import { getAntigravityModelQuota, getAntigravityQuotaCache } from "./antigravityQuota.ts"

export { apiKeyGateFailure, shouldLogAuthFailure } from "./keyGate.ts"

import * as log from "../utils/logger.ts"

/**
 * Retry a failed request with another credential when the failure is
 * account-scoped. A rate limit always gets one account-rotation attempt even
 * if account-health classification declines to persist a cooldown.
 */
export function shouldTryNextAccount(
	connectionId: string | null | undefined,
	status: number,
	shouldFallback: boolean,
): boolean {
	return (
		shouldFallback ||
		(status === HTTP_STATUS.RATE_LIMITED && Boolean(connectionId) && connectionId !== "noauth")
	)
}

// Mutex to prevent race conditions during account selection — PER PROVIDER.
//
// It was a single process-wide promise chain, which meant one provider's
// selection blocked every other provider's. That was invisible under fill-first
// (selection is read-only), but round-robin MUTATES the chosen account's
// lastUsedAt/consecutiveUseCount inside the critical section, so on a provider
// using it the whole gateway serialised behind one DB write per request:
// measured 349us/request with 40 concurrent selects, versus 65us fill-first.
//
// Selection state is per provider (an account belongs to exactly one provider,
// and the strategy/sticky limit are read per provider), so the lock only has to
// be held against concurrent selections OF THE SAME PROVIDER. Different
// providers can now select in parallel.
const selectionMutexes = new Map()

/**
 * Serialise account selection per provider.
 *
 * Exported so the locking property can be tested directly: the real selection
 * path cannot demonstrate it, because the default driver (node:sqlite) is
 * synchronous — its critical section never yields, so two providers never
 * visibly overlap and any wall-clock comparison measures noise. That is what made
 * an earlier end-to-end version of this test flaky rather than wrong.
 */
export function acquireSelectionMutex(key) {
	const current = selectionMutexes.get(key) || Promise.resolve()
	let release
	const next = new Promise((resolve) => {
		release = resolve
	})
	selectionMutexes.set(key, next)
	return {
		wait: current,
		release: () => {
			release()
			// Drop the entry once nobody is queued behind us, so the map cannot grow
			// one promise per provider forever.
			if (selectionMutexes.get(key) === next) selectionMutexes.delete(key)
		},
	}
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan"

function githubMonthlyResetMs(status, errorText, provider) {
	if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null
	if (
		!String(errorText || "")
			.toLowerCase()
			.includes(GITHUB_MONTHLY_USAGE_LIMIT)
	)
		return null
	const now = new Date()
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
}

/**
 * The account `getProviderCredentials` hands the request path.
 *
 * `allRateLimited` marks the "nothing selectable, here is when it frees up"
 * answer instead of an account; the rest mirrors the DB row plus the proxy
 * wiring resolved for this request.
 */
export interface ProviderCredentials {
	id?: string
	connectionId?: string
	connectionName?: string
	authType?: string | null
	apiKey?: string | null
	accessToken?: string | null
	refreshToken?: string | null
	idToken?: string | null
	expiresAt?: string | null
	expiresIn?: number | null
	lastRefreshAt?: string | null
	projectId?: string | null
	copilotToken?: string | null
	providerSpecificData?: Record<string, unknown>
	testStatus?: string | null
	lastError?: string | null
	isActive?: boolean
	_connection?: ProviderConnectionRecord
	allRateLimited?: boolean
	retryAfter?: string | null
	retryAfterHuman?: string | null
	lastErrorCode?: string | null
	[key: string]: unknown
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(
	provider: string,
	excludeConnectionIds: Set<string> | string | null = null,
	model: string | null = null,
	options: {
		preferredConnectionId?: string | null
		requestedModel?: string | null
		excludePoolIds?: Set<string>
		proxyPoolId?: string | null
	} = {},
): Promise<ProviderCredentials | null> {
	// Normalize to Set for consistent handling
	const excludeSet =
		excludeConnectionIds instanceof Set
			? excludeConnectionIds
			: excludeConnectionIds
				? new Set([excludeConnectionIds])
				: new Set()
	const preferredConnectionId = options?.preferredConnectionId || null
	const requestedModel = options?.requestedModel || model
	// Serialize round-robin selection against concurrent requests for this provider.
	const mutex = acquireSelectionMutex(resolveProviderId(provider))

	try {
		await mutex.wait

		// Resolve alias to provider ID (e.g., "kc" -> "kilocode")
		const providerId = resolveProviderId(provider)

		// Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
		if (FREE_PROVIDERS[providerId]?.noAuth) {
			const settings = await getSettings()
			const override = (settings.providerStrategies || {})[providerId] || {}
			const strategy = override.rotateStrategy || "none"
			const excludePoolIds =
				options?.excludePoolIds instanceof Set ? options.excludePoolIds : new Set<string>()
			const isExcluded = (id) =>
				excludePoolIds.has(id) || excludeSet.has(`proxy:${id}`) || excludeSet.has(id)
			let pickedId = override.proxyPoolId || null
			const allPools = strategy !== "none" || pickedId ? await getProxyPools({ isActive: true }) : []

			if (strategy !== "none") {
				const poolIds = allPools
					.filter((p) => p.proxyUrl)
					.map((p) => p.id)
					.filter((id) => !isExcluded(id))
				if (poolIds.length === 0) {
					log.warn("AUTH", `${provider} | all proxy pools exhausted (${excludeSet.size} excluded)`)
					return null
				}
				pickedId = pickProxyPoolId(poolIds, strategy, providerId, { excludePoolIds })
				// null means every candidate was already spent by this request. Falling
				// through would resolve a no-proxy ("noauth") route and egress from the
				// host's own IP, which is the leak this pool exists to prevent.
				if (!pickedId) {
					log.warn("AUTH", `${provider} | no proxy pool left to try in this request`)
					return null
				}
			} else if (pickedId && isExcluded(pickedId)) {
				// Rotation is off, so this pool was chosen explicitly. Silently
				// substituting another pool contradicts the selector — the UI promises
				// "Uses the selected pool above" — and sends traffic through an IP the
				// user deliberately did not pick. Stop instead.
				log.warn(
					"AUTH",
					`${provider} | selected proxy pool ${pickedId.slice(0, 8)} is unavailable; rotation is off so no substitute is used`,
				)
				return null
			} else if (!pickedId && excludeSet.has("noauth")) {
				log.warn("AUTH", `${provider} | direct no-auth route already tried`)
				return null
			}
			const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" })
			const sidMatch = (resolvedProxy.connectionProxyUrl || "").match(/-sid-(\d+)/i)
			const connectionId = pickedId
				? sidMatch
					? `proxy:${pickedId}:${sidMatch[1]}`
					: `proxy:${pickedId}`
				: "noauth"
			const connectionName = pickedId
				? resolvedProxy.proxyPool?.name || `Proxy (${pickedId.slice(0, 8)})`
				: "Public"
			return {
				id: connectionId,
				connectionId,
				connectionName,
				isActive: true,
				accessToken: "public",
				providerSpecificData: {
					connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
					connectionProxyUrl: resolvedProxy.connectionProxyUrl,
					connectionNoProxy: resolvedProxy.connectionNoProxy,
					connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
					proxyType: resolvedProxy.proxyPool?.type || resolvedProxy.source,
					relayUrl: resolvedProxy.relayUrl || "",
					vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
					strictProxy: resolvedProxy.strictProxy === true,
				},
			}
		}

		const connections = await getProviderConnections({ provider: providerId, isActive: true })
		log.debug(
			"AUTH",
			`${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`,
		)

		if (connections.length === 0) {
			log.warn("AUTH", `No credentials for ${provider}`)
			return null
		}

		// Antigravity quota cache is lazy: only populated after that account returns 409/429.
		const isAntigravity = providerId === "antigravity"
		const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null

		// Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
		const availableConnections = connections.filter((c) => {
			if (excludeSet.has(c.id)) return false
			if (isModelLockActive(c, model)) return false
			const enabled = c.providerSpecificData?.enabledModels
			if (
				providerId === "codex" &&
				Array.isArray(enabled) &&
				enabled.length &&
				requestedModel &&
				!enabled.includes(requestedModel)
			)
				return false
			// Antigravity: skip if live quota exhausted for this model
			if (isAntigravity && model && antigravityQuotaCache) {
				const connQuotas = antigravityQuotaCache.get(c.id)
				const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model]
				if (
					quota &&
					quota.remainingPercentage <= 0 &&
					quota.resetAt &&
					new Date(quota.resetAt).getTime() > Date.now()
				) {
					const account = c.id?.slice(0, 8) || "unknown"
					log.info(
						"AG_QUOTA",
						`${account} | CACHE_BLOCK ${model} - skip upstream until ${quota.resetAt}`,
					)
					return false
				}
			}
			return true
		})

		log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`)
		connections.forEach((c) => {
			const excluded = excludeSet.has(c.id)
			const locked = isModelLockActive(c, model)
			if (excluded || locked) {
				const lockUntil = getEarliestModelLockUntil(c)
				log.debug(
					"AUTH",
					`  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`,
				)
			}
		})

		if (availableConnections.length === 0) {
			// Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
			const lockedConns = connections.filter((c) => isModelLockActive(c, model))
			const expiries = lockedConns.map((c) => getEarliestModelLockUntil(c)).filter(Boolean)
			if (isAntigravity && model && antigravityQuotaCache) {
				connections.forEach((c) => {
					const connQuotas = antigravityQuotaCache.get(c.id)
					const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model]
					const resetAt = quota?.resetAt
					if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt)
				})
			}
			const earliest = expiries.sort()[0] || null
			if (earliest) {
				const earliestConn = lockedConns[0]
				log.warn(
					"AUTH",
					`${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${String(earliestConn?.lastError ?? "").slice(0, 50)}`,
				)
				return {
					allRateLimited: true,
					retryAfter: String(earliest),
					retryAfterHuman: formatRetryAfter(earliest),
					lastError: (earliestConn?.lastError as string | null | undefined) || null,
					lastErrorCode: (earliestConn?.errorCode as string | null | undefined) || null,
				}
			}
			log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`)
			return null
		}

		// Failure history survives the timed model lock. Prefer accounts with fewer
		// recorded failures so an expired lock does not immediately send traffic
		// back to the same account while healthier accounts remain available.
		const failureCounts = availableConnections.map((connection) => {
			const count = Math.max(0, Number(connection.rateLimitCount) || 0)
			return connection.lastRateLimitAt && count === 0 ? 1 : count
		})
		const lowestFailureCount = Math.min(...failureCounts)
		const selectionConnections = availableConnections.filter(
			(_, index) => failureCounts[index] === lowestFailureCount,
		)

		const settings = await getSettings()
		// Per-provider strategy overrides global setting
		const providerOverride = (settings.providerStrategies || {})[providerId] || {}
		const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first"

		let connection
		// Pin to preferred connection if specified and available
		if (preferredConnectionId) {
			connection = availableConnections.find((c) => c.id === preferredConnectionId)
			if (connection) {
				log.info(
					"AUTH",
					`${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`,
				)
			}
		}
		if (connection) {
			// skip strategy
		} else if (strategy === "round-robin") {
			const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3

			// Sort by lastUsed (most recent first) to find current candidate
			const byRecency = [...selectionConnections].sort((a, b) => {
				if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999)
				if (!a.lastUsedAt) return 1
				if (!b.lastUsedAt) return -1
				return Date.parse(String(b.lastUsedAt)) - Date.parse(String(a.lastUsedAt))
			})

			const current = byRecency[0]
			const currentCount = current?.consecutiveUseCount || 0

			if (current && current.lastUsedAt && currentCount < stickyLimit) {
				// Stay with current account
				connection = current
				// Update lastUsedAt and increment count (await to ensure persistence)
				await updateProviderConnection(connection.id, {
					lastUsedAt: new Date().toISOString(),
					consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1,
				})
			} else {
				// Pick the least recently used (excluding current if possible)
				const sortedByOldest = [...selectionConnections].sort((a, b) => {
					if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999)
					if (!a.lastUsedAt) return -1
					if (!b.lastUsedAt) return 1
					return Date.parse(String(a.lastUsedAt)) - Date.parse(String(b.lastUsedAt))
				})

				connection = sortedByOldest[0]

				// Update lastUsedAt and reset count to 1 (await to ensure persistence)
				await updateProviderConnection(connection.id, {
					lastUsedAt: new Date().toISOString(),
					consecutiveUseCount: 1,
				})
			}
		} else {
			// Default: fill-first (already sorted by priority in getProviderConnections)
			connection = selectionConnections[0]
		}

		const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {})

		return {
			authType: connection.authType,
			apiKey: connection.apiKey,
			accessToken: connection.accessToken,
			refreshToken: connection.refreshToken,
			idToken: connection.idToken,
			expiresAt: connection.expiresAt,
			expiresIn: connection.expiresIn,
			lastRefreshAt: connection.lastRefreshAt,
			projectId: connection.projectId,
			connectionName: connection.displayName || connection.name || connection.email || connection.id,
			copilotToken: connection.providerSpecificData?.copilotToken,
			providerSpecificData: {
				...(connection.providerSpecificData || {}),
				connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
				connectionProxyUrl: resolvedProxy.connectionProxyUrl,
				connectionNoProxy: resolvedProxy.connectionNoProxy,
				connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
				proxyType: resolvedProxy.proxyPool?.type || resolvedProxy.source,
				relayUrl: resolvedProxy.relayUrl || "",
				vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
				strictProxy: resolvedProxy.strictProxy === true,
			},
			connectionId: connection.id,
			// Include current status for optimization check
			testStatus: connection.testStatus,
			lastError: connection.lastError,
			// Pass full connection for clearAccountError to read modelLock_* keys
			_connection: connection,
		}
	} finally {
		mutex.release()
	}
}

/**
 * Extract the pool id from a synthetic proxy-backed connection id.
 * Shapes produced by getProviderCredentials: `proxy:<poolId>` and
 * `proxy:<poolId>:<rotatingSessionId>` (rotating residential pools).
 * @param {string} connectionId
 * @returns {string|null}
 */
function parseProxyPoolId(connectionId) {
	if (typeof connectionId !== "string" || !connectionId.startsWith("proxy:")) return null
	const rest = connectionId.slice("proxy:".length)
	if (!rest) return null
	// Rotating pools append `:<sid>`; the pool id itself never contains a colon.
	const poolId = rest.split(":")[0]
	return poolId || null
}

/**
 * Mark account+model as unavailable - locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @param {{ excludePoolIds?: Set<string>, proxyPoolId?: string|null }} [options] - No-auth proxy rotation
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(
	connectionId: string,
	status: number,
	errorText: string,
	provider: string | null = null,
	model: string | null = null,
	resetsAtMs: number | null = null,
	options: { proxyPoolId?: string | null; excludePoolIds?: Set<string> } = {},
): Promise<{ shouldFallback: boolean; cooldownMs: number }> {
	if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 }
	if (connectionId.startsWith("proxy:")) {
		const { shouldFallback, cooldownMs } = checkFallbackError(status, errorText, 0, provider)
		const proxyPoolId = options.proxyPoolId || connectionId.match(/^proxy:([^:]+)/)?.[1]
		if (shouldFallback && proxyPoolId) {
			options.excludePoolIds?.add(proxyPoolId)
			if (shouldRotateProxy(status, errorText)) {
				markProxyUnhealthy(
					resolveProviderId(provider),
					proxyPoolId,
					cooldownMs || MAX_RATE_LIMIT_COOLDOWN_MS,
				)
			}
		}
		return { shouldFallback, cooldownMs }
	}
	const connections = await getProviderConnections(provider ? { provider } : {})
	const conn = connections.find((c) => c.id === connectionId)
	const backoffLevel = Number(conn?.backoffLevel) || 0

	// Track repeated rate limits per account so the smart rotation can deprioritise
	// accounts that keep hitting limits instead of returning them to the pool as
	// soon as the raw cooldown expires.
	const now = Date.now()
	const rateLimitCount = (Number(conn?.rateLimitCount) || 0) + 1
	const lastRateLimitAt = now

	// GitHub premium-request exhaustion is account-wide until the next UTC month.
	const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider)

	// Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
	let shouldFallback: boolean
	let cooldownMs: number
	let shouldLock: boolean | undefined
	let newBackoffLevel: number | undefined
	if (githubResetAtMs) {
		shouldFallback = true
		cooldownMs = githubResetAtMs - Date.now()
		newBackoffLevel = 0
	} else if (resetsAtMs && resetsAtMs > Date.now()) {
		shouldFallback = true
		// Antigravity quota API provides exact per-model resetAt. Do not truncate it.
		cooldownMs =
			resolveProviderId(provider) === "antigravity"
				? resetsAtMs - Date.now()
				: Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS)
		newBackoffLevel = 0
	} else {
		;({ shouldFallback, cooldownMs, shouldLock, newBackoffLevel } = checkFallbackError(
			status,
			errorText,
			backoffLevel,
			resolveProviderId(provider),
		) as {
			shouldFallback: boolean
			cooldownMs: number
			shouldLock?: boolean
			newBackoffLevel?: number
		})
	}
	// A rejected request is the caller's mistake, so no account gets cooled down.
	if (shouldLock === false) return { shouldFallback: false, cooldownMs: 0 }
	if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 }

	const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error"
	const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs)

	await updateProviderConnection(connectionId, {
		...lockUpdate,
		testStatus: "unavailable",
		lastError: reason,
		errorCode: status,
		lastErrorAt: new Date().toISOString(),
		backoffLevel: newBackoffLevel ?? backoffLevel,
		lastRateLimitAt,
		rateLimitCount,
	})

	const lockKey = Object.keys(lockUpdate)[0]
	const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8)
	log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`)

	if (provider && status && reason) {
		console.error(`❌ ${provider} [${status}]: ${reason}`)
	}

	return { shouldFallback: true, cooldownMs }
}

/**
 * Record an account that answered 2xx but delivered no usable content.
 *
 * This is the silent twin of `markAccountUnavailable`. A loud failure (429/403)
 * is immediately conclusive, so it takes a model lock. An empty completion is
 * only weak evidence — the model really did answer, it just produced nothing
 * (a truncation at max_tokens, a content filter, a reasoning-only reply). Locking
 * the account would take a healthy credential out of rotation for a per-request
 * accident.
 *
 * But it must NOT be ignored either, and that was the bug: `rateLimitCount` only
 * ever incremented on loud failures, so an account that answers every request
 * with an empty 200 accumulated zero strikes and `selectRequiresHealthy` kept
 * preferring it over accounts with a couple of genuine rate limits. The counter
 * is what the selector reads, and half of the failure modes never wrote to it.
 *
 * So: one strike, no lock, and the strike decays by being cleared on the next
 * successful (non-empty) response — same lifecycle as a rate-limit strike.
 */
export async function markAccountEmptyResponse(
	connectionId: string | null | undefined,
	provider: string | null = null,
	reason = "Zero usable content",
): Promise<void> {
	if (!connectionId || connectionId === "noauth" || connectionId.startsWith("proxy:")) return
	const connections = await getProviderConnections(provider ? { provider } : {})
	const conn = connections.find((c) => c.id === connectionId)
	if (!conn) return

	await updateProviderConnection(connectionId, {
		rateLimitCount: (Number(conn.rateLimitCount) || 0) + 1,
		lastRateLimitAt: Date.now(),
		lastError: String(reason).slice(0, 200),
		lastErrorAt: new Date().toISOString(),
	})
	log.warn(
		"AUTH",
		`${conn.displayName || conn.name || connectionId.slice(0, 8)} answered empty, strike ${(Number(conn.rateLimitCount) || 0) + 1}`,
	)
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(
	connectionId: string,
	currentConnection: ProviderConnectionRecord | ProviderCredentials,
	model: string | null = null,
	provider: string | null = null,
): Promise<void> {
	if (!connectionId || connectionId === "noauth") return
	// Proxy-backed no-auth connections have no DB row. A success is still the
	// only signal that a pool recovered, so clear its in-memory cooldown and
	// re-pin it — otherwise a pool that hit one 429 stays parked until the
	// cooldown expires even though it is answering fine again.
	if (typeof connectionId === "string" && connectionId.startsWith("proxy:")) {
		const poolId = parseProxyPoolId(connectionId)
		if (poolId) markProxyHealthy(resolveProviderId(provider || ""), poolId)
		return
	}
	// Either shape carries the row's columns; the credentials object only adds a
	// `_connection` copy for the modelLock_* keys, so both index the same way.
	const conn = (("_connection" in currentConnection && currentConnection._connection) ||
		currentConnection) as Record<string, unknown>
	const now = Date.now()
	const allLockKeys = Object.keys(conn).filter((k) => k.startsWith("modelLock_"))

	if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return

	// Keys to clear: current model's lock + all expired locks
	const keysToClear = allLockKeys.filter((k) => {
		if (model && k === `modelLock_${model}`) return true // succeeded model
		if (model && k === "modelLock___all") return true // account-level lock
		const expiry = conn[k] as string | null | undefined
		return expiry && new Date(expiry).getTime() <= now // expired
	})

	if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return

	// Check if any active locks remain after clearing
	const remainingActiveLocks = allLockKeys.filter((k) => {
		if (keysToClear.includes(k)) return false
		const expiry = conn[k] as string | null | undefined
		return expiry && new Date(expiry).getTime() > now
	})

	const clearObj = Object.fromEntries(keysToClear.map((k) => [k, null]))

	// Only reset error state if no active locks remain
	if (remainingActiveLocks.length === 0) {
		Object.assign(clearObj, {
			testStatus: "active",
			lastError: null,
			errorCode: null,
			lastErrorAt: null,
			backoffLevel: 0,
			// Smart sticky: clear rate-limit memory on success so the account can
			// re-enter the normal rotation without a grace penalty.
			rateLimitCount: 0,
			lastRateLimitAt: null,
		})
	}

	await updateProviderConnection(connectionId, clearObj)
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request: Request): string | null {
	// Check Authorization header first
	const authHeader = request.headers.get("Authorization")
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7)
	}

	// Check Anthropic x-api-key header
	const xApiKey = request.headers.get("x-api-key")
	if (xApiKey) {
		return xApiKey
	}

	return null
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(
	apiKey: string | null,
	requestedModel: string | null = null,
	clientIp: string | null = null,
): Promise<ApiKeyVerdict> {
	if (!apiKey) return false
	void clientIp // per-IP limits live in the login limiter, not in the key verdict
	return await validateApiKey(apiKey, requestedModel)
}
