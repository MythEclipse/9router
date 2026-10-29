/**
 * Rules for importing a credential the operator already has.
 *
 * Four routes do the same thing with different providers: take a token (plus whatever else
 * that provider needs), prove it works before saving it, and write one connection. The rules
 * here are the parts that must not drift between them — the batch shape is in
 * `oauth-import.ts`.
 */

/** Why an import was refused before it touched the provider. */
export interface ImportRefusal {
	readonly message: string
}

/**
 * The trimmed string a field carries, or empty.
 *
 * Every import route trims: a token pasted from a browser or a terminal arrives with a
 * trailing newline often enough that an untrimmed comparison fails an otherwise valid token,
 * and the error it produces ("invalid token") points at the wrong thing.
 */
export function textFieldOf(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

/** The field's value as text, including a number that arrived as a JSON number. */
export function identityFieldOf(value: unknown): string {
	if (value === null || value === undefined) return ""
	return String(value).trim()
}

/**
 * Whether the request carries everything the provider needs.
 *
 * Ordered: the token is checked first because it is the one thing every caller has, so its
 * message is the one they will actually read.
 */
export function missingImportField(fields: {
	readonly accessToken: string
	readonly identity?: string
	readonly identityName?: string
}): ImportRefusal | null {
	// Trimmed here as well as by the caller: a body that skipped `textFieldOf` must not get
	// a whitespace-only token past this check and into a provider call.
	if (!fields.accessToken.trim()) return { message: "Access token is required" }
	if (fields.identity !== undefined && fields.identity === "") {
		return { message: `${fields.identityName ?? "User id"} is required` }
	}
	return null
}

/**
 * Kiro's two token shapes.
 *
 * A client id and secret mean the token is an organisation (IDC) token and has to be
 * refreshed at the regional OIDC endpoint; without them it is a social/builder-id token and
 * goes to the standard endpoint. Getting this wrong fails at refresh time, long after the
 * import reported success, so it is decided once, here.
 */
export function isIdcToken(clientId: string, clientSecret: string): boolean {
	return Boolean(clientId) && Boolean(clientSecret)
}

/** The auth method recorded on the connection, which the refresh path reads back. */
export function kiroAuthMethodOf(idc: boolean): "idc" | "imported" {
	return idc ? "idc" : "imported"
}

/** The label the dashboard shows for an imported Kiro connection. */
export function kiroProviderLabelOf(idc: boolean): "Enterprise" | "Imported" {
	return idc ? "Enterprise" : "Imported"
}

/**
 * The region an IDC token refreshes against.
 *
 * `us-east-1` is the default because that is where AWS puts an account that never chose a
 * region; an empty string from a cleared form field must not become the region.
 */
export function kiroRegionOf(region: string): string {
	return region || "us-east-1"
}

/**
 * An expiry for a token the provider did not date.
 *
 * An hour is what the IdPs themselves issue; a token with no expiry would be treated as
 * valid forever by every refresh check downstream.
 */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600

export function tokenExpiryOf(expiresIn: number | undefined, now: number): string {
	const seconds =
		typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME_SECONDS
	return new Date(now + seconds * 1000).toISOString()
}

/**
 * Whether a validation failure is the caller's token or the provider being down.
 *
 * 401 is the token: the operator can fix it by logging in again. Anything else — a 500 from
 * the provider, a timeout, a DNS failure — is not their fault and must not tell them to
 * re-authenticate, or they will keep re-pasting a token that was fine.
 */
export function validationStatusOf(error: unknown): 401 | 502 {
	const status = (error as { status?: unknown } | null | undefined)?.status
	return status === 401 || status === 403 ? 401 : 502
}

/** What a Codex access token says about the account it belongs to. */
export interface CodexTokenClaims {
	readonly email: string | null
	readonly chatgptAccountId: string | null
	readonly chatgptPlanType: string | null
	readonly expiresAtEpoch: number | null
}

/** The payload of a JWT, or null when the string is not one. */
export function jwtPayloadOf(token: string): Record<string, unknown> | null {
	const parts = token.split(".")
	if (parts.length !== 3) return null
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
		// `Buffer` rather than `atob`: the domain runs in Bun and in Node, and only one of
		// them guarantees a global `atob` with padding-tolerant base64.
		const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

/**
 * Read a Codex access token's claims without asking OpenAI.
 *
 * The token is a JWT the operator already holds, and everything the dashboard needs — the
 * email, the workspace, the plan — is inside it. A token that is not a JWT is still
 * importable: it is stored as-is and simply carries no claims, because refusing it would
 * reject a shape that works.
 */
export function codexClaimsOf(token: string): CodexTokenClaims {
	const payload = jwtPayloadOf(token)
	if (!payload) {
		return { email: null, chatgptAccountId: null, chatgptPlanType: null, expiresAtEpoch: null }
	}
	const auth = (payload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>
	const profile = (payload["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>
	const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null)

	return {
		email: text(profile.email) ?? text(payload.email) ?? text(payload.preferred_username),
		chatgptAccountId: text(auth.chatgpt_account_id),
		chatgptPlanType: text(auth.chatgpt_plan_type),
		expiresAtEpoch: typeof payload.exp === "number" ? payload.exp : null,
	}
}

/**
 * The name an imported Codex connection shows in the list.
 *
 * Falling back to the email and then to a fixed label keeps the row identifiable; an empty
 * name would leave the operator with a list of identical anonymous entries.
 */
export function codexConnectionName(name: string, claims: CodexTokenClaims): string {
	return name || claims.email || "ChatGPT Access Token"
}
