/**
 * Sub-key scoping.
 *
 * Pure. A key that can create keys may only mint one that is no more powerful
 * than itself — otherwise minting is a way to spend past the budget the creator
 * was given, or to reach models it was never allowed. Each cap is checked
 * against the creator's, and a wildcard request is clamped rather than granted.
 *
 * These rules were four inline blocks inside a 216-line handler, where the one
 * that mattered (token limit) and the one that did not (`limitKind`) looked
 * identical, and where "the creator has no limit" and "the creator's limit is
 * zero" were told apart by `> 0` in two places and not in the third.
 */

/**
 * The permission set a sub-key gets. The index signature is what makes a
 * caller's `Record<string, boolean>` assignable; the two flags are the ones the
 * key rules actually read, and naming them keeps them from being a typo away.
 */
export interface KeyPermissions {
	readonly viewUsage: boolean
	readonly manageApiKeys: boolean
	readonly [key: string]: boolean
}

/**
 * Accept a permission map from any source without widening the rules.
 *
 * The auth package's `PermissionSet` has no index signature, so it is not
 * directly assignable; this is the one place that reconciles the two shapes
 * instead of making each caller cast.
 */
export function asKeyPermissions(value: unknown): KeyPermissions | null {
	if (value === null || typeof value !== "object") return null
	const map = value as Record<string, unknown>
	return {
		...map,
		viewUsage: map.viewUsage === true,
		manageApiKeys: map.manageApiKeys === true,
	} as KeyPermissions
}

/** What a creator session is allowed to hand on. */
export interface CreatorScope {
	/** 0 or absent means unlimited. */
	readonly tokenLimit?: number | null
	/** 0 or absent means unlimited. Dollars. */
	readonly dailyCostLimit?: number | null
	/** Comma-separated model patterns, or null/absent for unconstrained. */
	readonly allowedModels?: string | null
	readonly allowedEndpoints?: readonly string[] | null
}

export interface RequestedKeyScope {
	readonly tokenLimit?: unknown
	readonly dailyCostLimit?: unknown
	readonly allowedModels?: string | null
	readonly allowedEndpoints?: readonly string[] | null
}

export interface ScopedKeyScope {
	readonly tokenLimit: number
	readonly dailyCostLimit: number
	readonly allowedModels: string
	readonly allowedEndpoints: readonly string[]
}

export type ScopeRejection =
	| { readonly field: "tokenLimit"; readonly creatorMax: number }
	| { readonly field: "dailyCostLimit"; readonly creatorMax: number }

/**
 * A creator's model restriction as patterns, or null when unrestricted.
 *
 * `"*"` and an empty value both mean every model, matching how the request gate
 * reads the same column.
 */
export function parseCreatorPatterns(value: string | null | undefined): string[] | null {
	const patterns = splitPatterns(value)
	if (patterns.length === 0 || (patterns.length === 1 && patterns[0] === "*")) return null
	return patterns
}

/**
 * A limit of 0 means "no cap" everywhere in this system, so only a positive
 * creator limit constrains anything. `Number(undefined)` is `NaN`, which is why
 * the coercion goes through this rather than a bare `Number(...)`.
 */
function asLimit(value: unknown): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Apply the creator's caps to what the sub-key asked for.
 *
 * Returns a rejection rather than silently lowering the value: if an operator
 * asked for a $50 cap and got $10, the key would stop working with no
 * explanation, and the number on screen would not match what they typed.
 */
export function scopeSubKey(
	requested: RequestedKeyScope,
	creator: CreatorScope,
	matches: (patterns: readonly string[], model: string) => boolean,
): { ok: true; value: ScopedKeyScope } | { ok: false; error: ScopeRejection } {
	const creatorTokens = asLimit(creator.tokenLimit)
	const requestedTokens = asLimit(requested.tokenLimit)
	if (creatorTokens > 0 && requestedTokens > creatorTokens) {
		return { ok: false, error: { field: "tokenLimit", creatorMax: creatorTokens } }
	}

	const creatorCost = asLimit(creator.dailyCostLimit)
	const requestedCost = asLimit(requested.dailyCostLimit)
	if (creatorCost > 0 && requestedCost > creatorCost) {
		return { ok: false, error: { field: "dailyCostLimit", creatorMax: creatorCost } }
	}

	return {
		ok: true,
		value: {
			tokenLimit: requestedTokens,
			dailyCostLimit: requestedCost,
			allowedModels: clampAllowedModels(
				requested.allowedModels,
				parseCreatorPatterns(creator.allowedModels),
				matches,
			),
			allowedEndpoints: clampEndpoints(requested.allowedEndpoints, creator.allowedEndpoints),
		},
	}
}

/**
 * Narrow requested model patterns to the creator's.
 *
 * `matches` is the caller's pattern matcher rather than an implementation
 * here. The pattern language (`exact`, `prefix*`, `*suffix`, `*`) already exists
 * in `packages/db` and is shared with the request gate and the model listing;
 * a second copy would drift, and the drift would show up as a key that is
 * allowed in the dashboard but refused at request time.
 *
 * A creator with no restriction passes the request through untouched. A
 * wildcard or empty request becomes exactly the creator's list, because a
 * wildcard cannot mean more than its creator was given.
 *
 * A request whose patterns survive none of the creator's is replaced by the
 * creator's list rather than by nothing: an empty allow-list in this system
 * means "no models", which would mint a key that can never serve a request.
 */
export function clampAllowedModels(
	requested: string | null | undefined,
	creatorPatterns: readonly string[] | null,
	matches: (patterns: readonly string[], model: string) => boolean,
): string {
	if (!creatorPatterns || creatorPatterns.length === 0) return requested?.trim() || "*"

	const requestedPatterns = splitPatterns(requested)
	if (requestedPatterns.length === 0 || requestedPatterns[0] === "*") {
		return creatorPatterns.join(",")
	}

	const allowed = requestedPatterns.filter(
		(pattern) => matches(creatorPatterns, pattern) || matches(creatorPatterns, `${pattern}/*`),
	)
	return allowed.length > 0 ? allowed.join(",") : creatorPatterns.join(",")
}

function splitPatterns(value: string | null | undefined): string[] {
	if (typeof value !== "string") return []
	return value
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part.length > 0)
}

/**
 * Endpoints a sub-key may have: the intersection, never the union.
 *
 * Mirrors `clampAllowedEndpoints` in `packages/db`, including its fallbacks: an
 * unrestricted creator admits whatever was asked, and a request that survives
 * none of the creator's endpoints falls back to the creator's list rather than
 * to nothing. It falls back because an empty endpoint list is a deny-all in this
 * system, and an operator who asked for nothing in particular wants a key that
 * works, not one that answers 403 to everything.
 */
export function clampEndpoints(
	requested: readonly string[] | null | undefined,
	creator: readonly string[] | null | undefined,
): readonly string[] {
	const creatorList = creator ?? []
	const wanted = requested ?? []
	if (creatorList.length === 0) return wanted
	if (wanted.length === 0) return creatorList
	const intersection = wanted.filter((endpoint) => creatorList.includes(endpoint))
	return intersection.length > 0 ? intersection : creatorList
}

/**
 * Whether a session authenticated by an API key may create one at all.
 *
 * A password session always may; a key session needs the permission explicitly,
 * because creating a key is a privilege escalation otherwise.
 */
export function mayCreateSubKey(
	role: string | null | undefined,
	permissions: KeyPermissions | null | undefined,
): boolean {
	if (role !== "apikey") return true
	return permissions?.manageApiKeys === true
}

/**
 * The permissions a sub-key is created with.
 *
 * A key session cannot grant anything at all, whatever it asks for — it gets the
 * default. The dashboard renders this as a disabled editor so the two agree.
 */
export function permissionsForSubKey(
	role: string | null | undefined,
	requested: KeyPermissions | null | undefined,
	defaults: KeyPermissions,
): KeyPermissions {
	if (role === "apikey") return defaults
	return requested ?? defaults
}

/**
 * Reject an endpoint request naming a kind that does not exist.
 *
 * The valid kinds are passed in because `packages/db` already owns that list and
 * a copy here would fall behind the moment a route is added — the copy I first
 * wrote was already missing two of the six.
 *
 * An unknown kind is refused rather than dropped: silently narrowing a typo'd
 * `["cht"]` to `[]` would create a key with no endpoints, and the operator would
 * see a success reply for a key that cannot serve anything.
 */
export function validateEndpointKinds(
	requested: unknown,
	allowedKinds: readonly string[],
): { ok: true; value: readonly string[] | undefined } | { ok: false; error: string } {
	if (requested === undefined) return { ok: true, value: undefined }
	if (!Array.isArray(requested)) {
		return {
			ok: false,
			error: `allowedEndpoints must be a subset of: ${allowedKinds.join(", ")}`,
		}
	}
	const kinds = Array.isArray(allowedKinds) ? allowedKinds : []
	const unknown = requested.find((kind) => !kinds.includes(kind))
	if (unknown !== undefined) {
		return {
			ok: false,
			error: `allowedEndpoints must be a subset of: ${allowedKinds.join(", ")}`,
		}
	}
	return { ok: true, value: requested }
}
