/**
 * What an API-key probe's HTTP status means.
 *
 * `validate/route.ts` decided this inline, twenty times, in a switch that also
 * carried each provider's URL, headers and body. The status rules had drifted
 * apart in ways that look arbitrary until you know the provider:
 *
 * - most providers answer 401 for a bad key, so "not 401 and not 403" is right
 * - `xai` answers 400 for a bad key and 403 for a valid key with no credit —
 *   so "not 401/403" would call a working key invalid
 * - `xiaomi-tokenplan` answers 403 for a valid key that may not list models,
 *   so only 401 is evidence against the key
 * - `blackbox` answers 400 for a malformed probe, not for a bad key
 * - `cloudflare-ai` answers 404 when the account id is wrong, which is still a
 *   configuration error and not a working credential
 * - `anthropic` answers 529 when overloaded; only 401 is evidence against it
 *
 * Six different readings, one of them wrong if applied to another provider's
 * endpoint. That is a domain decision, and it belongs somewhere it can be named
 * and tested rather than spelled out in the middle of a fetch call.
 */

/**
 * Which statuses the provider's endpoint uses to mean "this key is not accepted".
 *
 * Named rather than numeric so call sites read as intent: a probe that returns
 * {@link ProbeVerdict.rejected} on `invalidKey` is saying "the key is bad", even
 * though the provider answered 400.
 */

/** Statuses that reject the credential itself. */
const REJECTED = new Set([401, 403])

export type StatusReading =
	/** The key was refused. */
	| "rejected"
	/** The key was accepted; whatever else the status says is not about the key. */
	| "accepted"
	/** The endpoint could not tell us either way. */
	| "inconclusive"

/**
 * The default reading: 401 and 403 reject, everything else is accepted.
 *
 * This is what most probes need, including the fallback for providers that
 * publish no status rule of their own.
 */
export function readStatusDefault(status: number): StatusReading {
	return REJECTED.has(status) ? "rejected" : "accepted"
}

/** Only 401 rejects; a 403 means the key works but lacks a permission. */
export function readStatusRejectUnauthorizedOnly(status: number): StatusReading {
	return status === 401 ? "rejected" : "accepted"
}

/**
 * `xai`: 400 rejects, 403 means valid-but-out-of-credit.
 *
 * Reading it with the default rule calls an out-of-credit key valid, which is
 * the honest answer — the key authenticates; the account is empty.
 */
export function readStatusXai(status: number): StatusReading {
	if (status === 400) return "rejected"
	return "accepted"
}

/** `blackbox`: 200 and 400 both mean the key authenticated; the body was wrong. */
export function readStatusBlackbox(status: number): StatusReading {
	if (status === 200 || status === 400) return "accepted"
	if (REJECTED.has(status)) return "rejected"
	return "inconclusive"
}

/**
 * `cloudflare-ai`: a bad account id answers 404, and that is a configuration
 * error the operator must fix, so it counts against the credential too.
 */
export function readStatusCloudflare(status: number): StatusReading {
	if (status === 404) return "rejected"
	return readStatusDefault(status)
}

/**
 * `anthropic`: 529 is overload, not a credential verdict. Anything that is not
 * an explicit rejection is accepted — but a 5xx other than 529 says nothing.
 */
export function readStatusAnthropic(status: number): StatusReading {
	if (status === 401) return "rejected"
	if (status >= 500 && status !== 529) return "inconclusive"
	return "accepted"
}

/** The status readings a probe may name. */
export const STATUS_READINGS = {
	default: readStatusDefault,
	rejectUnauthorizedOnly: readStatusRejectUnauthorizedOnly,
	xai: readStatusXai,
	blackbox: readStatusBlackbox,
	cloudflare: readStatusCloudflare,
	anthropic: readStatusAnthropic,
} as const

export type StatusRule = keyof typeof STATUS_READINGS

/** Read a status with the rule the provider declares. */
export function readStatus(status: number, rule: StatusRule = "default"): StatusReading {
	return STATUS_READINGS[rule](status)
}

/**
 * The verdict reported to the dashboard.
 *
 * `inconclusive` is accepted: the dashboard is asking "may I save this key", and
 * a provider that answered with an overload or an unreadable body has given no
 * reason to refuse. The credential will be exercised on first use, and the
 * connection row carries `testStatus` for what that run finds.
 */
export function isAccepted(reading: StatusReading): boolean {
	return reading !== "rejected"
}

/**
 * A probe that produced no answer at all — a timeout, a socket that never
 * opened. Distinct from a rejection because the key is not known to be bad.
 */
export function readFailure(): StatusReading {
	return "inconclusive"
}
