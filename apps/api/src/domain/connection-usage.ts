/**
 * Who may ask for a connection's quota, and what a refresh implies.
 *
 * `/api/usage/[connectionId]` does two things that are easy to conflate: it *fetches* quota
 * from a provider (transport, in `open-sse`) and it decides *whether this connection can be
 * asked at all* (this module). The second part was buried in the handler behind five nested
 * conditions, and each branch had a different failure already baked in:
 *
 * - **Auth types are spelled more than one way.** OAuth connections store `oauth`; generic
 *   API-key providers store `apikey`; Kiro's headless flow stores `api_key`. A check that
 *   accepted only one spelling refused a connection that worked everywhere else.
 *
 * - **A custom-quota node is eligible through the node, not the connection.** Those nodes opt
 *   in to a standard quota endpoint with `quotaEnabled`; when the node has not opted in, the
 *   connection is not eligible *however good its auth type is* — there is no endpoint to call.
 *   Treating it as eligible turns a clean "not available" into a 500 from upstream.
 *
 * - **An expired-auth message arrives as a 200.** Several providers answer the quota request
 *   with a body saying "token expired" instead of a 401. Read as a success, the operator sees
 *   an empty quota card for an account that simply needs to log in again.
 */

/** Auth types that mean "this connection holds a refreshable token". */
export function isOAuthConnection(connection: { readonly authType?: unknown } | null): boolean {
	return connection?.authType === "oauth"
}

/**
 * Auth types that mean "this connection holds a static API key".
 *
 * `api_key` is Kiro's headless flow; `apikey` is every other provider. Both persist the same
 * thing, so both are accepted — a build that knew only one spelling hid quota for the other
 * set of connections.
 */
export function isApiKeyAuth(connection: { readonly authType?: unknown } | null): boolean {
	return connection?.authType === "apikey" || connection?.authType === "api_key"
}

/**
 * Whether this connection may be asked for quota at all.
 *
 * Three routes to eligibility: OAuth, a whitelisted API-key provider, or a custom-quota node
 * that opted in. The order matters only for readability — the answer is the disjunction.
 */
export function canReadConnectionUsage(input: {
	readonly connection: { readonly authType?: unknown; readonly provider?: unknown } | null
	readonly customQuotaEnabled: boolean
	readonly usageApiKeyProviders: readonly string[]
}): boolean {
	const connection = input.connection
	if (!connection) return false
	if (isOAuthConnection(connection)) return true
	if (input.customQuotaEnabled) return true
	if (!isApiKeyAuth(connection)) return false
	return input.usageApiKeyProviders.includes(String(connection.provider ?? ""))
}

/** What the handler should do after reading a quota response. */
export type AuthExpiryVerdict =
	| { readonly kind: "ok" }
	| { readonly kind: "retry-after-refresh" }
	| { readonly kind: "reauthorize"; readonly message: string }

/**
 * The fragments a provider uses to say "your token is no longer good" inside a 200 body.
 *
 * `re-authorize` is included because some providers phrase it as an instruction, and a missed
 * match leaves the operator staring at an empty quota card with nothing to act on — the least
 * diagnosable state this route has.
 */
const AUTH_EXPIRED_PATTERNS = [
	"expired",
	"authentication",
	"unauthorized",
	"401",
	"re-authorize",
] as const

/** Whether a usage payload is actually an auth-expiry message. */
export function isAuthExpiredUsage(usage: unknown): boolean {
	if (usage == null || typeof usage !== "object") return false
	const message = (usage as { message?: unknown }).message
	if (typeof message !== "string" || message === "") return false
	const lower = message.toLowerCase()
	return AUTH_EXPIRED_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * Decides whether to retry a quota read.
 *
 * A retry needs a refresh token: an access-token-only connection cannot be force-refreshed, so
 * retrying repeats the same call and doubles the latency for nothing. And it only applies to
 * OAuth — an API-key connection saying "expired" means the key itself is dead, where no refresh
 * helps, so the operator is told to reconnect instead of watching a spinner.
 */
export function authExpiryVerdict(input: {
	readonly usage: unknown
	readonly isOAuth: boolean
	readonly hasRefreshToken: boolean
}): AuthExpiryVerdict {
	if (!isAuthExpiredUsage(input.usage)) return { kind: "ok" }
	if (input.isOAuth && input.hasRefreshToken) return { kind: "retry-after-refresh" }
	if (input.isOAuth) return { kind: "ok" }
	return {
		kind: "reauthorize",
		message: "This connection's credential was rejected. Reconnect it and try again.",
	}
}

/** The message shown when a forced refresh fails, naming the provider for context. */
export function refreshFailureMessage(provider: unknown, reason: unknown): string {
	const name = typeof provider === "string" && provider !== "" ? provider : "unknown"
	const detail = reason instanceof Error ? reason.message : String(reason ?? "unknown error")
	return `[Usage] ${name}: force refresh failed: ${detail}`
}

/** A refresh result, as an executor returns it. Every field is optional. */
export interface TokenRefreshResult {
	readonly accessToken?: string
	readonly refreshToken?: string
	readonly idToken?: string
	readonly lastRefreshAt?: string
	readonly expiresIn?: number
	readonly expiresAt?: string
	readonly copilotToken?: string
	readonly copilotTokenExpiresAt?: string
	readonly providerSpecificData?: Record<string, unknown>
}

/**
 * The row written to `providerConnections` after a refresh.
 *
 * The index signature is what lets this be handed to the repo's
 * `updateProviderConnection(id, patch)` unchanged — that helper accepts a partial record with
 * an open shape, and a closed interface is not assignable to it.
 */
export interface TokenUpdate {
	[key: string]: unknown
	updatedAt: string
	accessToken?: string
	refreshToken?: string
	idToken?: string
	lastRefreshAt?: string
	expiresAt?: string
	expiresIn?: number
	providerSpecificData?: Record<string, unknown>
}

/**
 * The update a refresh result implies.
 *
 * Split out because the handler built it across forty lines of `if` blocks where two rules were
 * load-bearing and unstated. `expiresIn` wins over `expiresAt` — a relative lifetime is what the
 * provider just said, while an absolute one may be the value we already had. And
 * `providerSpecificData` is merged, never replaced: GitHub's `copilotToken` sits there beside
 * fields the refresh knows nothing about, and replacing the object logs the account out.
 */
export function tokenUpdateFromRefresh(input: {
	readonly refresh: TokenRefreshResult
	readonly existingProviderSpecificData: Record<string, unknown> | null | undefined
	readonly now: number
}): TokenUpdate {
	const refresh = input.refresh
	const update: TokenUpdate = { updatedAt: new Date(input.now).toISOString() }

	if (refresh.accessToken) update.accessToken = refresh.accessToken
	if (refresh.refreshToken) update.refreshToken = refresh.refreshToken
	if (refresh.idToken) update.idToken = refresh.idToken
	if (refresh.lastRefreshAt) update.lastRefreshAt = refresh.lastRefreshAt

	if (typeof refresh.expiresIn === "number" && refresh.expiresIn > 0) {
		update.expiresIn = refresh.expiresIn
		update.expiresAt = new Date(input.now + refresh.expiresIn * 1000).toISOString()
	} else if (refresh.expiresAt) {
		update.expiresAt = refresh.expiresAt
	}

	const specific = {
		...(refresh.providerSpecificData ?? {}),
		...(refresh.copilotToken ? { copilotToken: refresh.copilotToken } : {}),
		...(refresh.copilotTokenExpiresAt
			? { copilotTokenExpiresAt: refresh.copilotTokenExpiresAt }
			: {}),
	}
	if (Object.keys(specific).length > 0) {
		update.providerSpecificData = { ...(input.existingProviderSpecificData ?? {}), ...specific }
	}

	return update
}

/**
 * The connection as it should be handed back after a refresh.
 *
 * `providerSpecificData` comes from the update when the update carried any, and otherwise from
 * the connection — reading it off the update unconditionally blanks it for a provider whose
 * refresh returned no provider-specific fields.
 */
export function connectionAfterRefresh<T extends { providerSpecificData?: unknown }>(
	connection: T,
	update: { providerSpecificData?: Record<string, unknown> },
): T {
	return {
		...connection,
		...update,
		providerSpecificData:
			update.providerSpecificData !== undefined
				? update.providerSpecificData
				: connection.providerSpecificData,
	}
}

/**
 * The connection as a custom-quota node wants it seen.
 *
 * The node carries the base URL and quota path the provider was configured with, so merging
 * them in lets the standard quota handler run unchanged. `quotaPath` defaults to `/credits`
 * because that is the endpoint every compatible node was modelled on.
 */
export function customQuotaConnection<T extends { providerSpecificData?: unknown }>(
	connection: T,
	node: { readonly baseUrl?: unknown; readonly quotaPath?: unknown; readonly name?: unknown },
): T {
	const existing = (connection.providerSpecificData ?? {}) as Record<string, unknown>
	return {
		...connection,
		providerSpecificData: {
			...existing,
			baseUrl: node.baseUrl || existing.baseUrl,
			quotaEnabled: true,
			quotaPath: node.quotaPath || "/credits",
			nodeName: node.name,
		},
	}
}

/** The body both the "not available" branches answer with. */
export const NOT_AVAILABLE_MESSAGE = "Usage not available for this connection"

/**
 * The proxy options a quota read uses.
 *
 * `strictProxy: false` is deliberate: quota and credential refresh must fall back to a direct
 * connection when the configured proxy is down. A quota card that fails because a proxy is
 * unreachable reports the account as broken when it is fine.
 */
export function quotaProxyOptions(proxyConfig: {
	readonly connectionProxyEnabled?: unknown
	readonly connectionProxyUrl?: unknown
	readonly connectionNoProxy?: unknown
	readonly vercelRelayUrl?: unknown
}): {
	connectionProxyEnabled: boolean
	connectionProxyUrl: string
	connectionNoProxy: string
	vercelRelayUrl: string
	strictProxy: false
} {
	return {
		connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
		connectionProxyUrl:
			typeof proxyConfig.connectionProxyUrl === "string" ? proxyConfig.connectionProxyUrl : "",
		connectionNoProxy:
			typeof proxyConfig.connectionNoProxy === "string" ? proxyConfig.connectionNoProxy : "",
		vercelRelayUrl: typeof proxyConfig.vercelRelayUrl === "string" ? proxyConfig.vercelRelayUrl : "",
		strictProxy: false,
	}
}
