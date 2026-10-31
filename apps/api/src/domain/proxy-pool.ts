/**
 * Rules for proxy pools: the egress paths provider connections may be bound to.
 *
 * A pool is not just a stored row. A connection bound to it loses its egress path the
 * moment the pool disappears, and the failure shows up later as a request that cannot
 * be dialled. Every rule below is about that consequence.
 */

/** The pool types the dashboard can create. */
export const PROXY_POOL_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify"] as const

export type ProxyPoolType = (typeof PROXY_POOL_TYPES)[number]

/** The scheme check, passed in because the serving runtime owns what it can dial. */
export type SchemeCheck = (url: string) => boolean

/** The writable fields of a proxy pool. */
export interface ProxyPoolInput {
	readonly name: string
	readonly proxyUrl: string
	readonly noProxy: string
	readonly isActive: boolean
	readonly strictProxy: boolean
	readonly type: ProxyPoolType
}

/** What a create or update refused, and why. */
export interface PoolRefusal {
	readonly error: string
}

const UNSUPPORTED_SCHEME =
	"Proxy URL must use http:// or https:// — socks proxies are not supported by the serving runtime"

function typeOf(requested: unknown): ProxyPoolType {
	return typeof requested === "string" && (PROXY_POOL_TYPES as readonly string[]).includes(requested)
		? (requested as ProxyPoolType)
		: "http"
}

/**
 * The pool a create request describes.
 *
 * `isActive` defaults to **true** — a pool created and left unconfigured should carry
 * traffic, because the alternative is a pool the dashboard shows and the router
 * silently skips. An explicit `false` is honoured; any other non-boolean is treated as
 * "not specified" and becomes the default.
 *
 * The URL is checked against the scheme the runtime can actually dial, at configuration
 * time. A pool saved with a `socks5://` URL would answer every request with
 * `UnsupportedProxyProtocol` while the no-leak policy blocks the direct fallback — a
 * permanently dead pool the dashboard reports as healthy. Saving is the only moment the
 * operator can still fix it.
 */
export function poolInputOf(
	body: Record<string, unknown>,
	supportedScheme: SchemeCheck,
): ProxyPoolInput | PoolRefusal {
	const name = typeof body.name === "string" ? body.name.trim() : ""
	const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : ""
	const noProxy = typeof body.noProxy === "string" ? body.noProxy.trim() : ""

	if (!name) return { error: "Name is required" }
	if (!proxyUrl) return { error: "Proxy URL is required" }
	if (!supportedScheme(proxyUrl)) return { error: UNSUPPORTED_SCHEME }

	return {
		name,
		proxyUrl,
		noProxy,
		isActive: body.isActive === undefined ? true : body.isActive === true,
		strictProxy: body.strictProxy === true,
		type: typeOf(body.type),
	}
}

/**
 * The patch an update request describes.
 *
 * Only keys the caller *sent* are present, because the store treats an absent key as
 * "leave it alone". That is the difference between `Object.hasOwn` and a truthiness
 * test: clearing `noProxy` works while omitting it does not clear it.
 *
 * A name or URL sent as an empty string is refused rather than stored: both are what the
 * pool is *for*, and a pool with neither cannot be used or found.
 */
export function poolUpdateOf(
	body: Record<string, unknown>,
	supportedScheme: SchemeCheck,
): { readonly patch: Record<string, unknown>; readonly refusal: string | null } {
	const updates: Record<string, unknown> = {}
	const refuse = (message: string) => ({ patch: updates, refusal: message })

	if (Object.hasOwn(body, "name")) {
		const name = typeof body.name === "string" ? body.name.trim() : ""
		if (!name) return refuse("Name is required")
		updates.name = name
	}

	if (Object.hasOwn(body, "proxyUrl")) {
		const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : ""
		if (!proxyUrl) return refuse("Proxy URL is required")
		if (!supportedScheme(proxyUrl)) return refuse(UNSUPPORTED_SCHEME)
		updates.proxyUrl = proxyUrl
	}

	if (Object.hasOwn(body, "noProxy")) {
		updates.noProxy = typeof body.noProxy === "string" ? body.noProxy.trim() : ""
	}

	if (Object.hasOwn(body, "isActive")) updates.isActive = body.isActive === true
	if (Object.hasOwn(body, "strictProxy")) updates.strictProxy = body.strictProxy === true
	if (Object.hasOwn(body, "type")) updates.type = typeOf(body.type)

	return { patch: updates, refusal: null }
}

/** A connection, as far as pool usage is concerned. */
export interface PoolBoundConnection {
	readonly providerSpecificData?: { readonly proxyPoolId?: unknown } | null
}

/**
 * How many connections point at a pool.
 *
 * Matched by string equality: the id lives inside an opaque JSON column, and the ids are
 * generated as strings, so a coercion here would hide a row written by something that
 * skipped that.
 */
export function boundConnectionCount(
	connections: readonly PoolBoundConnection[],
	poolId: string,
): number {
	let count = 0
	for (const connection of connections) {
		if (connection?.providerSpecificData?.proxyPoolId === poolId) count += 1
	}
	return count
}

/** How many connections point at *any* of these pools. */
export function boundCountAcross(
	connections: readonly PoolBoundConnection[],
	poolIds: readonly string[],
): number {
	const wanted = new Set(poolIds)
	let count = 0
	for (const connection of connections) {
		const id = connection?.providerSpecificData?.proxyPoolId
		if (typeof id === "string" && wanted.has(id)) count += 1
	}
	return count
}

/**
 * A bound pool may not be deleted.
 *
 * The connection would keep its stored `proxyPoolId` and lose its egress path, and the
 * failure appears on the next request as a dial error with nothing pointing at the
 * deletion. The answer carries the count so the dashboard can name what is in the way
 * instead of asking the operator to hunt for it.
 */
export function poolDeletionRefusal(boundCount: number): PoolRefusal | null {
	return boundCount > 0 ? { error: "Proxy pool is currently in use" } : null
}

export function bulkDeletionRefusal(boundCount: number): PoolRefusal | null {
	return boundCount > 0 ? { error: "Some proxy pools are currently in use" } : null
}

/**
 * The ids a bulk delete should act on.
 *
 * `{ all: true }` deletes every pool; `{ ids: [...] }` deletes exactly those. Both are
 * resolved on the server, so "delete all" does not depend on the browser having paged
 * through the list first — a browser that had not yet scrolled would otherwise leave
 * pools behind while reporting success.
 *
 * Duplicates collapse, blanks are dropped, and an id that is not a string is ignored
 * rather than stringified: `5` becoming `"5"` would delete a pool nobody named.
 */
export function bulkDeleteIdsOf(
	body: Record<string, unknown>,
	allIds: readonly string[],
): string[] {
	if (body.all === true) return [...new Set(allIds)]
	if (!Array.isArray(body.ids)) return []
	return [...new Set(body.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))]
}

/**
 * Which of the requested ids were actually removed.
 *
 * A store that silently skipped an id is what this exists for: the answer names the
 * missing ids instead of reporting a count the dashboard would render as complete.
 */
export function deletionOutcome(
	requested: readonly string[],
	removed: readonly { readonly id: string }[],
): { deleted: string[]; deletedCount: number; missing: string[] } {
	const removedIds = new Set(removed.map((pool) => pool.id))
	return {
		deleted: [...removedIds],
		deletedCount: removed.length,
		missing: requested.filter((id) => !removedIds.has(id)),
	}
}

/**
 * The `isActive` filter off a query.
 *
 * `?isActive=true` and `?isActive=false` filter; anything else — absent, `1`, `yes` —
 * means no filter at all, because a typo should widen the listing rather than silently
 * answer an empty one.
 */
export function activeFilterOf(raw: string | null): boolean | undefined {
	if (raw === "true") return true
	if (raw === "false") return false
	return undefined
}

/** Which pools are tested through a relay rather than dialled directly. */
export const RELAY_POOL_TYPES: readonly ProxyPoolType[] = [
	"vercel",
	"cloudflare",
	"deno",
	"netlify",
]

/**
 * Whether a pool of this type is tested by calling a relay endpoint.
 *
 * A deployed relay has no proxy URL to dial — the pool stores the deployment's own URL,
 * and the way to prove it works is to ask *it* to fetch something. Dialling it as an
 * HTTP proxy would fail for every healthy relay, so the distinction has to be made
 * before the test, not after a failure.
 */
export function usesRelay(type: string): boolean {
	return (RELAY_POOL_TYPES as readonly string[]).includes(type)
}

/** What a test attempt recorded. */
export interface PoolTestOutcome {
	readonly ok: boolean
	readonly status?: number | null
	readonly statusText?: string | null
	readonly error?: string | null
	readonly elapsedMs?: number | null
}

/** The host a relay is asked to fetch, and the marker its answer carries. */
export const RELAY_PROBE_TARGET = "https://httpbin.org"
export const RELAY_PROBE_PATH = "/get"
const RELAY_PROBE_MARKER = "httpbin.org/get"

/**
 * Whether a relay's answer proves it actually proxied.
 *
 * A relay is a URL that takes `x-relay-target` and fetches it. A 200 alone proves
 * nothing: a deployment whose entrypoint was never compiled into a function serves its
 * own source with `200 application/octet-stream`, a rewrite to the wrong file serves that
 * file, and a captive portal serves a login page. All three look healthy to a status-code
 * check, and the pool then stays `active` while every relayed request returns nonsense.
 *
 * So the probe asks for a host whose answer is recognisable and looks for that answer.
 * The target's own body is the only evidence the hop happened.
 */
export function relayProxied(body: string): boolean {
	return body.includes(RELAY_PROBE_MARKER)
}

/**
 * The row a test attempt writes back.
 *
 * **A test moves `isActive`.** That is a real coupling and it is worth stating: a pool
 * that fails its test becomes inactive, so the router stops sending traffic through a
 * path that is known broken rather than retrying it per request. The operator can turn
 * it back on by hand; the next test will move it again. Both directions matter — a pool
 * that was switched off by hand and then tests clean comes back on.
 *
 * `lastError` is cleared on success rather than left stale, because a screen showing
 * "last error: ECONNREFUSED" beside "status: active" is worse than showing nothing.
 */
export function testResultPatch(
	outcome: PoolTestOutcome,
	testedAt: string,
): Record<string, unknown> {
	return {
		testStatus: outcome.ok ? "active" : "error",
		lastTestedAt: testedAt,
		lastError: outcome.ok ? null : outcome.error || `Proxy test failed with status ${outcome.status}`,
		isActive: outcome.ok,
	}
}

/**
 * The answer the dashboard renders after a test.
 *
 * Absent numbers become `0` and absent strings `null`, so the screen never renders
 * `undefined` as "undefined ms" — the elapsed time of a failure that never started is
 * zero, not unknown.
 */
export function poolTestView(outcome: PoolTestOutcome, testedAt: string): Record<string, unknown> {
	return {
		ok: outcome.ok,
		status: outcome.status ?? null,
		statusText: outcome.statusText || null,
		error: outcome.error || null,
		elapsedMs: outcome.elapsedMs || 0,
		testedAt,
	}
}
