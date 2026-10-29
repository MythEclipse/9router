/**
 * Starting a MiMo Desktop login.
 *
 * The region is not cosmetic: it selects the cluster's upstream base, and only non-CN clusters
 * may need an overseas exit for the login page's geo-decided features. Those two decisions are
 * rules; the socket probing that implements them is the host's business.
 */

/** The clusters MiMo Desktop serves, and the only values a caller may ask for. */
export const MIMO_REGIONS = ["cn", "sgp", "ams", "ru", "in"] as const

export type MimoRegion = (typeof MIMO_REGIONS)[number]

/** Where a login lands when the caller says nothing, or says something unknown. */
export const MIMO_DEFAULT_REGION: MimoRegion = "cn"

/**
 * Reads the requested region.
 *
 * An unknown region falls back to CN rather than failing: the value arrives from a dropdown
 * that a stale browser may have cached, and a login that works in the default cluster is a
 * better answer than an error nobody can act on. Case is normalised because the UI sends
 * lower case while a hand-written request may not.
 */
export function readMimoRegion(body: unknown): MimoRegion {
	const raw = (body as { region?: unknown } | null)?.region
	const region = typeof raw === "string" ? raw.trim().toLowerCase() : ""
	return (MIMO_REGIONS as readonly string[]).includes(region)
		? (region as MimoRegion)
		: MIMO_DEFAULT_REGION
}

/**
 * Whether starting this login should look for a local HTTP proxy first.
 *
 * CN is always direct — the login page is served from inside the network that reaches it, and
 * routing it through an overseas exit would be slower and could look like a different country
 * signing in. Every other cluster may need that exit, so it is worth probing for one.
 */
export function needsEgressProbe(region: MimoRegion): boolean {
	return region !== "cn"
}

/**
 * The egress decision, in the words the log uses.
 *
 * An operator debugging a login needs to know whether a proxy was found, and which — but the
 * resolved URL can carry credentials, so those are removed before it is ever logged.
 */
export interface MimoEgress {
	readonly proxyUrl: string | null
	readonly source: "direct" | "local-probe"
}

export function directEgress(): MimoEgress {
	return { proxyUrl: null, source: "direct" }
}

export function probedEgress(found: string | null): MimoEgress {
	return found ? { proxyUrl: found, source: "local-probe" } : directEgress()
}

/** The egress URL with any `user:pass@` removed, safe to log. */
export function redactedEgress(egress: MimoEgress): string {
	if (!egress.proxyUrl) return ""
	return egress.proxyUrl.replace(/\/\/[^@/]+@/, "//***@")
}

/**
 * The first hop's answer must point at the account SSO host.
 *
 * A 200 with no redirect, or a redirect to somewhere else, means the cluster is not behaving
 * like a login surface — there is no page to hand the browser, so the caller must be told the
 * upstream is wrong rather than sent to a dead URL.
 */
export function firstHopRefusal(status: number, location: string | null): string | null {
	if (!location || !/account\.xiaomi\.com/.test(location)) {
		return `Unexpected me response (${status}) - no account redirect`
	}
	return null
}

/** The second hop must name the SPA page to load. */
export function secondHopRefusal(status: number, location: string | null): string | null {
	return location ? null : `Unexpected serviceLogin response (${status})`
}

/** How long the browser keeps the login session cookie alive while the operator signs in. */
export const MIMO_LOGIN_SESSION_SECONDS = 15 * 60

/** What a login-status poll answers, given what the session holds now. */
export type MimoLoginStatus = "expired" | "pending" | "done" | "error"

/**
 * Decides the next answer for a status poll.
 *
 * `expired` wins over everything: a session the browser no longer has cannot be reported as
 * pending, or the modal would spin forever on a cookie that is already gone. `done` requires
 * an identity, so a session that finished without a passToken is `error` rather than `done`
 * with nothing in it — the client persists what this returns, and an empty identity would be
 * saved as a connection that cannot authenticate.
 */
export function mimoLoginStatus(holds: {
	readonly sessionPresent: boolean
	readonly stateMatches: boolean
	readonly identityPresent: boolean
}): MimoLoginStatus {
	if (!holds.sessionPresent || !holds.stateMatches) return "expired"
	return holds.identityPresent ? "done" : "pending"
}

/** The HTTP status each answer carries. */
export function mimoLoginStatusHttp(status: MimoLoginStatus): number {
	return status === "expired" ? 404 : 200
}
