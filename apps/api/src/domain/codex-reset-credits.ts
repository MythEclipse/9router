/**
 * Codex reset credits: who may ask, when to refresh, and what a consume result means.
 *
 * Five rules were spread across a 198-line route with two near-identical handlers, and two of them
 * only ever showed up as a wrong status code:
 *
 * - **Eligibility is provider *and* auth type.** A Codex connection without an OAuth or
 *   access-token credential has nothing to present upstream, so it is refused up front with 400
 *   rather than failing later as a 500.
 * - **Only an OAuth connection refreshes.** An access-token connection has no refresh token; a
 *   handler that refreshes it anyway reports "credential refresh failed" for a connection that
 *   never needed one.
 * - **Auth-expiry is a text match, on both the thrown error and the returned body.** The upstream
 *   reports expiry as a 200 with an error message in several shapes, so checking only the thrown
 *   error misses the common case and returns an expiry as if it were credits.
 * - **Exactly one retry, and only with a refresh token in hand.** Retrying without one loops.
 * - **A failed consume is not a 500.** A 4xx upstream status is the caller's answer (409 for no
 *   credit); anything else is a 502 — this service could not get an answer, it did not break.
 */

/** Upstream phrasings that mean "the credential is no longer accepted". */
export const AUTH_EXPIRED_PATTERNS = [
	"expired",
	"authentication",
	"unauthorized",
	"401",
	"re-authorize",
] as const

/** Auth types that can present a credential to the Codex reset-credit endpoint. */
const CODEX_AUTH_TYPES = new Set(["oauth", "access_token"])

/** The provider id this endpoint serves. */
export const CODEX_PROVIDER = "codex"

/**
 * Whether a result or error mentions an expired credential.
 *
 * All four carriers are read — `message`, `code`, and the two shapes the upstream nests a detail
 * under. Reading only `message` misses `{error: {code: "401"}}`, which is how the upstream most
 * often answers.
 */
export function isAuthExpired(...carriers: readonly unknown[]): boolean {
	const values = carriers
		.flatMap((carrier) => {
			const record = carrier as Record<string, unknown> | null | undefined
			const raw = record?.raw as Record<string, unknown> | null | undefined
			const nested = raw?.error as Record<string, unknown> | null | undefined
			return [record?.message, record?.code, raw?.detail, nested?.code, nested?.message]
		})
		.filter(Boolean)
		.map((value) => String(value).toLowerCase())
	return values.some((value) => AUTH_EXPIRED_PATTERNS.some((pattern) => value.includes(pattern)))
}

/** What the handler should do with a connection before calling upstream. */
export type CodexEligibility =
	| { readonly ok: true; readonly isOAuth: boolean }
	| { readonly ok: false; readonly status: 400 | 404; readonly message: string }

/** A refusal, narrowed.
 *
 * `apps/web` compiles with `strict: false`, where `if (!verdict.ok)` does not narrow the union.
 * A type predicate does, and it keeps working if strict is turned on later.
 */
export function isCodexRefusal(
	verdict: CodexEligibility,
): verdict is Extract<CodexEligibility, { ok: false }> {
	return !verdict.ok
}

/**
 * Whether this connection can use reset credits, and whether a refresh comes first.
 *
 * Three refusals, not one. A missing connection is 404 — the id is wrong. A connection for another
 * provider, or a Codex connection with no OAuth/access-token credential, is 400 — the request is
 * wrong. Collapsing these into one status tells a caller to stop asking about a connection that
 * does not exist when their id was simply mistyped.
 */
export function codexEligibility(
	connection:
		| {
				readonly provider?: unknown
				readonly authType?: unknown
		  }
		| null
		| undefined,
): CodexEligibility {
	if (!connection) {
		return { ok: false, status: 404, message: "Connection not found" }
	}
	if (connection.provider !== CODEX_PROVIDER) {
		return {
			ok: false,
			status: 400,
			message: "Codex reset credits are only available for Codex connections.",
		}
	}
	const authType = String(connection.authType ?? "")
	if (!CODEX_AUTH_TYPES.has(authType)) {
		return {
			ok: false,
			status: 400,
			message: "Codex reset credits require an OAuth or access-token connection.",
		}
	}
	return { ok: true, isOAuth: authType === "oauth" }
}

/**
 * Whether an auth-expired answer may be retried.
 *
 * Both halves matter: retrying a non-OAuth connection has no refresh path, and retrying an OAuth
 * connection with no refresh token refreshes nothing — the second call fails exactly like the
 * first, which the caller experiences as a spinner that never resolves.
 */
export function canRetryAfterExpiry(
	isOAuth: boolean,
	hasRefreshToken: boolean,
	expired: boolean,
): boolean {
	return isOAuth && hasRefreshToken && expired
}

/**
 * The HTTP response for a consume result.
 *
 * `noCredit` is 409, not an error: the caller asked for something legitimate that is not available
 * right now. The request id is echoed so a support report can be matched to an upstream log.
 */
export function consumeOutcome(
	result: {
		readonly ok?: unknown
		readonly noCredit?: unknown
		readonly code?: unknown
		readonly status?: unknown
		readonly message?: unknown
		readonly windowsReset?: unknown
		readonly raw?: { readonly credit?: unknown } | null
	},
	redeemRequestId: string,
): { readonly body: Record<string, unknown>; readonly status: number } {
	if (result.ok) {
		return {
			status: 200,
			body: {
				code: result.code,
				reset: true,
				windows_reset: result.windowsReset,
				redeemRequestId,
				credit: result.raw?.credit ?? null,
			},
		}
	}

	if (result.noCredit) {
		return {
			status: 409,
			body: {
				code: "no_credit",
				reset: false,
				windows_reset: result.windowsReset,
				message: "No Codex reset credits available.",
			},
		}
	}

	const upstream = Number(result.status)
	const status = upstream >= 400 && upstream < 500 ? upstream : 502
	return {
		status,
		body: {
			code: result.code ?? "unknown_response",
			reset: false,
			windows_reset: result.windowsReset,
			message: result.message ?? "Codex reset credit consume returned an unexpected response.",
		},
	}
}

/**
 * The proxy options this endpoint passes upstream.
 *
 * `strictProxy: false` on purpose: a dead proxy must not make a healthy account look broken, and
 * reading reset credits is harmless to retry without one.
 */
export function codexProxyOptions(
	resolved:
		| {
				readonly connectionProxyEnabled?: unknown
				readonly connectionProxyUrl?: unknown
				readonly connectionNoProxy?: unknown
				readonly vercelRelayUrl?: unknown
		  }
		| null
		| undefined,
): {
	connectionProxyEnabled: boolean
	connectionProxyUrl: string
	connectionNoProxy: string
	vercelRelayUrl: string
	strictProxy: false
} {
	return {
		connectionProxyEnabled: resolved?.connectionProxyEnabled === true,
		connectionProxyUrl: String(resolved?.connectionProxyUrl ?? ""),
		connectionNoProxy: String(resolved?.connectionNoProxy ?? ""),
		vercelRelayUrl: String(resolved?.vercelRelayUrl ?? ""),
		strictProxy: false,
	}
}
