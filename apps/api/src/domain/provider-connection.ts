/**
 * Provider connection write rules.
 *
 * Two handlers wrote a provider connection and each carried its own copy of the
 * proxy rules. The copies had drifted on one point that matters: the create copy
 * could not tell "the caller sent no proxy fields" from "the caller sent them
 * empty", so a create always rewrote `connectionProxyEnabled: false` over
 * whatever was stored, while an update with no proxy fields left them alone.
 * Same request body, two different stored rows.
 *
 * The rules here state, once, what each field means:
 *
 * - absent  → the caller said nothing; do not touch what is stored
 * - present → the caller said something; validate it and write it
 *
 * `connectionProxyEnabled` follows its URL: enabling without a URL is refused
 * rather than stored as a connection that believes it has a proxy and does not.
 */

/** The three legacy proxy fields, which live flat on the request body. */
export interface ProxyFields {
	[key: string]: unknown
	readonly connectionProxyEnabled?: unknown
	readonly connectionProxyUrl?: unknown
	readonly connectionNoProxy?: unknown
}

export type ProxyConfig =
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly message: string }
	| {
			readonly kind: "set"
			readonly enabled: boolean
			readonly url: string
			readonly noProxy: string
	  }

const PROXY_FIELDS = ["connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy"] as const

function isPresent(body: ProxyFields, field: (typeof PROXY_FIELDS)[number]): boolean {
	return Object.hasOwn(body, field)
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

/**
 * Read the proxy fields a request carried.
 *
 * `absent` when the body mentions none of them — which is the common case, and
 * the one the old create copy got wrong by treating as "disable".
 */
export function readProxyConfig(body: ProxyFields = {}): ProxyConfig {
	if (!PROXY_FIELDS.some((field) => isPresent(body, field))) return { kind: "absent" }

	const enabled = body.connectionProxyEnabled === true
	const url = readString(body.connectionProxyUrl)
	const noProxy = readString(body.connectionNoProxy)

	if (enabled && !url) {
		return {
			kind: "invalid",
			message: "Connection proxy URL is required when connection proxy is enabled",
		}
	}

	return { kind: "set", enabled, url, noProxy }
}

/** Merge a proxy decision into the provider-specific data about to be written. */
export function applyProxyConfig(
	stored: Record<string, unknown> | null | undefined,
	config: ProxyConfig,
): Record<string, unknown> {
	const merged = { ...(stored ?? {}) }
	if (config.kind !== "set") return merged

	merged.connectionProxyEnabled = config.enabled
	merged.connectionProxyUrl = config.url
	merged.connectionNoProxy = config.noProxy
	return merged
}

/** A pool id the caller explicitly cleared. */
export type ProxyPoolChoice =
	| { readonly kind: "absent" }
	| { readonly kind: "cleared" }
	| { readonly kind: "set"; readonly proxyPoolId: string }

/**
 * Read the requested pool id, before it is checked against the pool store.
 *
 * `"__none__"` is the sentinel the dashboard sends for "no pool"; it means the
 * same thing as an empty string and as an explicit null.
 */
export function readProxyPoolChoice(value: unknown): ProxyPoolChoice {
	if (value === undefined) return { kind: "absent" }
	if (value === null) return { kind: "cleared" }

	const trimmed = String(value).trim()
	if (!trimmed || trimmed === "__none__") return { kind: "cleared" }
	return { kind: "set", proxyPoolId: trimmed }
}

/** Merge a pool decision into the provider-specific data about to be written. */
export function applyProxyPoolChoice(
	stored: Record<string, unknown>,
	choice: ProxyPoolChoice,
): Record<string, unknown> {
	if (choice.kind === "absent") return stored
	if (choice.kind === "cleared") {
		const { proxyPoolId: _removed, ...rest } = stored
		return rest
	}
	return { ...stored, proxyPoolId: choice.proxyPoolId }
}

/**
 * The ordinal for an unnamed key on this provider.
 *
 * Several keys per provider is the normal case — the router fails over between
 * them — so two keys both named "Gemini" collide and the second write is refused
 * with 409, leaving a one-key pool that cannot fall back. So each unnamed key
 * takes the next free `#N`.
 *
 * Re-adding a key that is already stored reuses its ordinal: that request is an
 * edit of the existing entry, not the arrival of a new one, and must keep its
 * name.
 */
export function nextKeyOrdinal(
	existing: ReadonlyArray<{ readonly name?: string | null; readonly apiKey?: string | null }>,
	apiKey?: string | null,
): number {
	const sameKey = apiKey ? existing.find((connection) => connection.apiKey === apiKey) : null
	const reuse = sameKey ? ordinalOf(sameKey.name) : null
	if (reuse !== null) return reuse

	const taken = new Set<number>()
	for (const connection of existing) {
		const ordinal = ordinalOf(connection.name)
		if (ordinal !== null) taken.add(ordinal)
	}

	let ordinal = 1
	while (taken.has(ordinal)) ordinal++
	return ordinal
}

function ordinalOf(name: string | null | undefined): number | null {
	const match = / #(\d+)$/.exec(name ?? "")
	if (!match) return null
	const ordinal = Number(match[1])
	return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null
}

/** `Gemini #2` — the default name for the next key on a provider. */
export function defaultConnectionName(providerLabel: string, ordinal: number): string {
	return `${providerLabel} #${ordinal}`
}

/**
 * The name a new connection should carry.
 *
 * An explicit name always wins, then a display name, then the generated ordinal
 * name. Blank strings count as absent: an empty name is not a name.
 */
export function chooseConnectionName(input: {
	readonly name?: unknown
	readonly displayName?: unknown
	readonly providerLabel: string
	readonly ordinal: number
}): string {
	const explicit = typeof input.name === "string" ? input.name.trim() : ""
	if (explicit) return explicit

	const display = typeof input.displayName === "string" ? input.displayName.trim() : ""
	if (display) return display

	return defaultConnectionName(input.providerLabel, input.ordinal)
}

/**
 * A write-only secret nested inside `providerSpecificData`.
 *
 * The AWS session token is the case this exists for: the connection form can
 * write it but cannot read it back, because the store never returns it. So an
 * edit always sends the field empty, and "empty" has to mean *keep*, or every
 * saved token would be overwritten with a blank the first time anyone renames
 * the connection.
 *
 * That makes three states, and they cannot be expressed by `null` alone:
 *
 * - absent → the field was not in the request; leave the stored value alone
 * - `""`   → the form sent its blank; keep the stored value
 * - `null` → the operator cleared it; remove it
 */
export type WriteOnlySecret = "absent" | "cleared" | { readonly value: unknown }

export function readWriteOnlySecret(value: unknown): WriteOnlySecret {
	if (value === undefined) return "absent"
	if (value === null) return "cleared"
	if (typeof value === "string" && value.trim() === "") return "absent"
	return { value }
}

/** Apply a {@link WriteOnlySecret} decision to the data about to be written. */
export function applyWriteOnlySecret(
	data: Record<string, unknown>,
	field: string,
	secret: WriteOnlySecret,
): Record<string, unknown> {
	if (secret === "absent") return data
	if (secret === "cleared") {
		const { [field]: _removed, ...rest } = data
		return rest
	}
	return { ...data, [field]: secret.value }
}
