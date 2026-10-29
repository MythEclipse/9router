/**
 * Provider header overrides.
 *
 * The operator may add HTTP headers to a provider's upstream requests — a
 * gateway that wants its own routing tag, an on-prem proxy that needs an extra
 * token. This is the trust boundary for that: the dashboard validates too, but a
 * hand-rolled request does not go through the dashboard.
 *
 * Three limits, each closing a way a header map becomes something other than a
 * header map:
 *
 * - the name must be an RFC 7230 token, so it cannot carry a space or a colon
 * - the value cannot contain CR or LF, which is header injection
 * - a short blocklist refuses the headers that would break the request itself
 *   (`host`, `content-length`, `transfer-encoding`) or smuggle a credential in
 *   past the connection's own (`authorization`, `cookie`)
 *
 * `content-type` is refused for the second reason: the provider's body is JSON
 * and a caller who overrides the type desynchronises the request from the body.
 */

/** The most headers one provider may carry. */
export const MAX_HEADERS = 20

/** The longest single header value, in characters. */
export const MAX_HEADER_VALUE_LENGTH = 8192

/** Letters, digits and hyphen only — no spaces, no unicode. */
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/

const BLOCKED_HEADERS = new Set([
	"host",
	"content-length",
	"content-type",
	"connection",
	"transfer-encoding",
	"authorization",
	"cookie",
])

/** A stored override. Only headers may be overridden. */
export interface ProviderOverride {
	readonly headers?: Record<string, string>
}

export type OverrideResult =
	/** `null` means "no headers left" — the caller deletes the stored entry. */
	| { readonly kind: "ok"; readonly override: ProviderOverride | null }
	| { readonly kind: "invalid"; readonly message: string }

/**
 * Validate and normalise an override payload.
 *
 * A field that is absent, null or a blank string is not a header, so an override
 * whose headers are all blank normalises to `null`: clearing every value is how
 * the dashboard deletes the override, and it should not leave `{}` behind.
 */
export function readOverride(payload: { headers?: unknown }): OverrideResult {
	const headers = payload.headers

	if (headers === undefined || headers === null) return { kind: "ok", override: null }
	if (typeof headers !== "object" || Array.isArray(headers)) {
		return { kind: "invalid", message: "headers must be an object" }
	}

	const entries = Object.entries(headers as Record<string, unknown>).filter(
		([, value]) => value !== "" && value !== null && value !== undefined,
	)
	if (entries.length > MAX_HEADERS) {
		return { kind: "invalid", message: `Too many headers (max ${MAX_HEADERS})` }
	}

	const clean: Record<string, string> = {}
	for (const [name, value] of entries) {
		if (!HEADER_NAME_RE.test(name)) {
			return { kind: "invalid", message: `Invalid header name: ${name}` }
		}
		if (typeof value !== "string" || /[\r\n]/.test(value)) {
			return { kind: "invalid", message: `Invalid value for header ${name}` }
		}
		if (value.length > MAX_HEADER_VALUE_LENGTH) {
			return {
				kind: "invalid",
				message: `Header ${name} value too long (max ${MAX_HEADER_VALUE_LENGTH})`,
			}
		}
		if (BLOCKED_HEADERS.has(name.toLowerCase())) {
			return { kind: "invalid", message: `Header ${name} cannot be overridden` }
		}
		clean[name] = value
	}

	return { kind: "ok", override: Object.keys(clean).length > 0 ? { headers: clean } : null }
}

/**
 * The override map with one provider set or cleared.
 *
 * Clearing deletes the key rather than storing an empty object, so the settings
 * row does not accumulate a growing list of providers the operator once touched.
 */
export function withOverride(
	current: Record<string, ProviderOverride>,
	provider: string,
	override: ProviderOverride | null,
): Record<string, ProviderOverride> {
	if (override) return { ...current, [provider]: override }
	const { [provider]: _removed, ...rest } = current
	return rest
}
