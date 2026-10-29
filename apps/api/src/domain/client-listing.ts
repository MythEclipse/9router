/**
 * What the client-facing connection listing may show.
 *
 * This endpoint is the one place a connection leaves the dashboard: the usage
 * panel reads it. It therefore has to answer three questions the route answered
 * inline and in the wrong order — what may be disclosed, which connections are
 * worth showing at all, and how a page is cut.
 *
 * The disclosure rule was a whitelist applied after the filter, which meant a
 * secret could be read by the sorting comparator before it was ever stripped.
 * Here sanitising happens first, and everything else reads the sanitised value.
 */

/** The connection fields the client may see. Nothing else leaves this module. */
export const SAFE_FIELDS = [
	"id",
	"provider",
	"authType",
	"name",
	"email",
	"displayName",
	"priority",
	"globalPriority",
	"isActive",
	"defaultModel",
	"testStatus",
	"lastError",
	"lastErrorAt",
	"errorCode",
	"expiresAt",
	"lastUsedAt",
	"consecutiveUseCount",
	"createdAt",
	"updatedAt",
] as const

/**
 * The `providerSpecificData` fields the client may see.
 *
 * Still a whitelist, and still deliberate: a compatible provider's node config
 * lives in this blob, and a future field holding a secret would otherwise be
 * disclosed by default. Proxy credentials are excluded on purpose — the panel
 * shows *that* a proxy is configured, never its URL.
 */
export const SAFE_PROVIDER_SPECIFIC_FIELDS = [
	"baseUrl",
	"azureEndpoint",
	"deployment",
	"apiVersion",
	"accountId",
	"region",
	"projectId",
	"resourceUrl",
	"proxyPoolId",
	"connectionProxyEnabled",
	"githubLogin",
	"githubName",
	"githubEmail",
	"githubUserId",
	"username",
	"firstName",
	"lastName",
	"authMethod",
	"authKind",
	"profileArn",
	"nodeName",
	"quotaEnabled",
	"quotaPath",
] as const

/** A connection as the store returns it, before anything is stripped. */
export interface RawConnection {
	readonly provider: string
	readonly authType?: string | null
	readonly isActive?: boolean | null
	readonly priority?: number | null
	readonly providerSpecificData?: Record<string, unknown> | null
	readonly [key: string]: unknown
}

/** A connection as the client sees it. */
export type ClientConnection = Record<string, unknown>

/**
 * A long opaque token in a name, masked in place.
 *
 * Some providers name a connection after its own key or session id. A name is
 * the one field an operator writes freely, so it is also the one field that can
 * carry a secret by accident; anything 32 characters of `[A-Za-z0-9_-]` is
 * treated as such and cut to its first eight characters.
 */
export function maskName(name: unknown): unknown {
	if (typeof name !== "string" || name.length <= 16) return name
	if (/[a-zA-Z0-9_-]{32,}/.test(name)) return `${name.slice(0, 8)}***`
	return name
}

/** Only the whitelisted top-level fields, with the name masked. */
function pickSafeFields(connection: RawConnection): ClientConnection {
	const safe: ClientConnection = {}
	for (const field of SAFE_FIELDS) {
		if (connection[field] !== undefined) safe[field] = connection[field]
	}
	safe.name = maskName(safe.name)
	return safe
}

/** Only the whitelisted `providerSpecificData` fields. */
function pickSafeProviderFields(raw: Record<string, unknown>): Record<string, unknown> {
	const safe: Record<string, unknown> = {}
	for (const field of SAFE_PROVIDER_SPECIFIC_FIELDS) {
		if (raw[field] !== undefined) safe[field] = raw[field]
	}
	return safe
}

/**
 * Strip a connection down to what the client may see.
 *
 * A missing `providerSpecificData` stays missing rather than becoming `{}`:
 * the panel distinguishes "this provider has no extra config" from "its config
 * was withheld", and an empty object erases that distinction.
 */
export function sanitizeConnection(connection: RawConnection): ClientConnection {
	const safe = pickSafeFields(connection)
	const specific = connection.providerSpecificData
	if (specific) safe.providerSpecificData = pickSafeProviderFields(specific)
	return safe
}

/**
 * Whether a connection's usage can be read at all.
 *
 * Two questions, in order: a compatible provider is eligible only when its node
 * opted into quota tracking, because there is no vendor endpoint to ask; a
 * built-in provider is eligible when the registry says its usage endpoint exists
 * *and* the account can authenticate to it — an OAuth account always can, an
 * api-key account only for the providers whose usage endpoint accepts a key.
 */
export function isUsageEligible(
	connection: RawConnection,
	nodeById: ReadonlyMap<string, { readonly quotaEnabled?: boolean }>,
	registry: {
		readonly isCompatible: (provider: string) => boolean
		readonly supportsUsage: (provider: string) => boolean
		readonly supportsApiKeyUsage: (provider: string) => boolean
	},
): boolean {
	if (registry.isCompatible(connection.provider)) {
		return nodeById.get(connection.provider)?.quotaEnabled === true
	}
	return (
		registry.supportsUsage(connection.provider) &&
		(connection.authType === "oauth" || registry.supportsApiKeyUsage(connection.provider))
	)
}

/** Which accounts to list. Only `active` and `inactive` narrow; anything else lists both. */
export type AccountStatus = "all" | "active" | "inactive"

export function isAccountStatus(value: string): value is AccountStatus {
	return value === "all" || value === "active" || value === "inactive"
}

/**
 * Whether an account passes the status filter.
 *
 * An absent `isActive` reads as active, which every other reader in the codebase
 * already assumes; treating it as inactive would hide connections the router
 * still uses.
 */
export function matchesAccountStatus(connection: RawConnection, status: AccountStatus): boolean {
	if (status === "active") return connection.isActive ?? true
	if (status === "inactive") return !(connection.isActive ?? true)
	return true
}

/** How the client asked for the list to be ordered. */
export type ConnectionSort = "priority" | "provider"

export function isConnectionSort(value: string): value is ConnectionSort {
	return value === "priority" || value === "provider"
}

/**
 * Order the listing.
 *
 * `provider` groups by the registry's own usage order first, so the panel reads
 * the same way the provider table does, then alphabetically within a provider.
 * `priority` puts unset priorities last — a connection with no priority is not a
 * connection with priority zero, and treating it as such would float every
 * unconfigured account to the top.
 */
export function sortConnections<T extends RawConnection>(
	connections: readonly T[],
	sort: ConnectionSort,
	registry: { readonly usageOrder: readonly string[] },
): T[] {
	const list = [...connections]
	const usageRank = (provider: string) => {
		const rank = registry.usageOrder.indexOf(provider)
		return rank === -1 ? registry.usageOrder.length : rank
	}
	const priorityOf = (value: number | null | undefined) =>
		value === null || value === undefined ? Number.MAX_SAFE_INTEGER : Number(value)

	if (sort === "provider") {
		return list.sort(
			(a, b) => usageRank(a.provider) - usageRank(b.provider) || a.provider.localeCompare(b.provider),
		)
	}
	return list.sort(
		(a, b) => priorityOf(a.priority) - priorityOf(b.priority) || a.provider.localeCompare(b.provider),
	)
}

/** Page size defaults and ceiling, matching what the panel asks for. */
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 500

/**
 * A positive integer from a query string, or the fallback.
 *
 * `Number.parseInt("")` is `NaN`, `"12abc"` is `12`, and `"-3"` is negative —
 * the route accepted all three. Only a whole positive number is taken, so a
 * malformed page number falls back instead of silently reading page 0.
 */
export function parsePositiveInt(value: string | null, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** The page a request asked for, clamped to the ceiling. */
export function resolvePageSize(value: string | null): number {
	return Math.min(parsePositiveInt(value, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
}

/**
 * One page of a sorted list.
 *
 * A page past the end is clamped to the last page rather than returning an empty
 * slice, which is what the route did — the panel keeps its page number across a
 * filter change, so requesting page 7 of what is now 2 pages must still show
 * rows. `totalPages` is at least 1 so "page 1 of 1" survives an empty list.
 */
export function paginate<T>(
	items: readonly T[],
	page: number,
	pageSize: number,
): { readonly items: readonly T[]; readonly page: number; readonly totalPages: number } {
	const total = items.length
	const totalPages = Math.max(1, Math.ceil(total / pageSize))
	// Clamp from below as well as above: `page: 0` would otherwise yield
	// `offset: -pageSize`, and a negative `slice` index means "from the end" — the
	// last page served as if it were the first. The route clamped only the ceiling.
	const current = Math.max(1, Math.min(page, totalPages))
	const offset = (current - 1) * pageSize
	return { items: items.slice(offset, offset + pageSize), page: current, totalPages }
}
