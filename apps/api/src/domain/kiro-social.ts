/**
 * Kiro's social sign-in.
 *
 * AWS Cognito requires the `kiro://` custom protocol for the callback, so the browser cannot
 * complete this flow on its own: the operator is sent to Google or GitHub, and the code comes
 * back by pasting the custom-protocol URL. That is why the verifier round-trips through the
 * client instead of living in a server session.
 */

/** The social identity providers Kiro accepts. */
export const KIRO_SOCIAL_PROVIDERS = ["google", "github"] as const

export type KiroSocialProvider = (typeof KIRO_SOCIAL_PROVIDERS)[number]

/**
 * Reads a provider name from a query string or body.
 *
 * Only the two supported providers are accepted, and they are named in the refusal: the
 * screen offers exactly these, so anything else came from a stale bundle or a hand-written
 * request, and telling the operator the valid values is what lets them recover.
 */
export function readKiroSocialProvider(
	raw: unknown,
	refusal: string,
): { ok: boolean; error?: string; provider?: KiroSocialProvider } {
	const name = typeof raw === "string" ? raw.trim().toLowerCase() : ""
	return (KIRO_SOCIAL_PROVIDERS as readonly string[]).includes(name)
		? { ok: true, provider: name as KiroSocialProvider }
		: { ok: false, error: refusal }
}

/** The fields the exchange step needs, both of which the client supplies. */
export interface KiroSocialExchangeInput {
	readonly code: string
	readonly codeVerifier: string
	readonly provider: KiroSocialProvider
}

/**
 * Reads the exchange body.
 *
 * The code and the verifier are checked before the provider so that a missing field reads as
 * "Missing required fields" rather than as an invalid provider — the second is a much rarer
 * mistake and pointing at it first would send the operator to the wrong place.
 */
export function readKiroSocialExchange(body: unknown): {
	ok: boolean
	error?: string
	input?: KiroSocialExchangeInput
} {
	const fields = (body ?? {}) as Record<string, unknown>
	const code = typeof fields.code === "string" ? fields.code : ""
	const codeVerifier = typeof fields.codeVerifier === "string" ? fields.codeVerifier : ""
	if (!code || !codeVerifier) return { ok: false, error: "Missing required fields" }

	const provider = readKiroSocialProvider(fields.provider, "Invalid provider")
	if (!provider.ok) return { ok: false, error: provider.error }
	return {
		ok: true,
		input: { code, codeVerifier, provider: provider.provider as KiroSocialProvider },
	}
}

/**
 * How the provider is recorded on the connection row.
 *
 * Two spellings, both needed: `authMethod` is the machine-readable one the refresh path reads,
 * and `provider` is the capitalised label the connections list shows.
 */
export function kiroSocialLabels(provider: KiroSocialProvider): {
	authMethod: KiroSocialProvider
	provider: string
} {
	return {
		authMethod: provider,
		provider: provider.charAt(0).toUpperCase() + provider.slice(1),
	}
}

/** When an access token obtained now expires, as the ISO string the row stores. */
export function kiroExpiryFrom(expiresInSeconds: number, now: number): string {
	return new Date(now + expiresInSeconds * 1000).toISOString()
}
