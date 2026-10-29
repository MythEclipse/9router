/**
 * The dashboard login is the only place where being wrong is a vulnerability rather than a bug.
 *
 * Every rule below was inline in a 280-line handler, and each one has a failure mode that does not
 * look like a failure from the outside:
 *
 * - **An exhausted quota still signs in.** `validateApiKey` answers `QUOTA_EXCEEDED`, and the
 *   tempting reading is "reject the credential". But the usage page is where the bar sits at 100%,
 *   so refusing the session hides the exact state the operator needs to see. Request-side limits
 *   stay enforced because the SSE handler validates again. This is the one non-`true` verdict that
 *   is actually a pass.
 * - **A fresh install's default password does not earn a session remotely.** `123456` is published
 *   in every README; issuing a JWT for it lets anyone on the internet authenticate and then
 *   `PATCH /api/settings` to disable authentication. From the operator's own machine it is fine —
 *   they are the one who installed it. The distinction is *where* the login came from, not how
 *   correct the password was, and it is why the refusal withholds the token instead of setting a
 *   flag on it.
 * - **A wrong API key burns the same attempt counter as a wrong password.** Otherwise the password
 *   path is rate-limited and the key path is a free guessing oracle.
 * - **Password login is refused only when the configured SSO is actually configured.** A settings
 *   row saying `authMode: "saml"` with no entry point is a half-finished configuration, and
 *   refusing there locks the operator out of their own dashboard with no way back in.
 *
 * What is deliberately *not* here: the comparisons themselves. `bcrypt.compare`, the limiter and
 * its counters, the cookie writer, and the audit sink are all still performed by the route — this
 * module decides, it does not perform.
 */

/** What `validateApiKey` can answer. Most are rejections; `QUOTA_EXCEEDED` is not. */
export type ApiKeyVerdict =
	| true
	| "QUOTA_EXCEEDED"
	| "KEY_DISABLED"
	| "KEY_EXPIRED"
	| false
	| string

/**
 * Whether a key verdict admits a session.
 *
 * `QUOTA_EXCEEDED` is accepted on purpose — see the module comment. Everything else must be a
 * literal `true`; an unrecognised verdict is a rejection, because the safe reading of "validity
 * unknown" is "no".
 */
export function apiKeyAdmitsSession(verdict: ApiKeyVerdict): boolean {
	return verdict === true || verdict === "QUOTA_EXCEEDED"
}

/** Why a key was rejected, phrased for the operator rather than the log. */
export function apiKeyRejectionReason(verdict: ApiKeyVerdict): string {
	if (verdict === "KEY_DISABLED") return "API key is disabled"
	if (verdict === "KEY_EXPIRED") return "API key is expired"
	return "Invalid API key"
}

/**
 * The message a wrong credential earns, with the attempts it has left.
 *
 * The count is part of the answer: without it the operator cannot tell a typo from a lockout they
 * are one attempt away from.
 */
export function credentialRejection(reason: string, remainingBeforeLock: number): string {
	return `${reason}. ${remainingBeforeLock} attempt(s) left before lockout.`
}

/** The message a locked-out caller earns, with the wait. */
export function lockoutMessage(retryAfter: number): string {
	return `Too many failed attempts. Try again in ${retryAfter}s.`
}

/**
 * Whether a login arrived over the tunnel or Tailscale host this install advertises.
 *
 * Compared against the configured hostnames rather than by address range: a reverse proxy makes
 * every remote caller look local, so the only trustworthy statement is "this request's `Host`
 * header is the one we published".
 *
 * A settings value that is not a URL yields no hostname — an unparseable tunnel URL must not
 * throw, or one bad setting takes down the login page instead of just its gate.
 */
export function isTunnelRequest(host: string | null | undefined, settings: unknown): boolean {
	const requestHost = String(host ?? "")
		.split(":")[0]
		.toLowerCase()
	if (requestHost === "") return false

	const row = (settings as Record<string, unknown> | null) ?? {}
	for (const key of ["tunnelUrl", "tailscaleUrl"]) {
		const published = publishedHostname(row[key])
		if (published !== null && requestHost === published) return true
	}
	return false
}

/** The hostname a published URL advertises, or null when it does not parse. */
function publishedHostname(value: unknown): string | null {
	if (typeof value !== "string" || value === "") return null
	try {
		return new URL(value).hostname.toLowerCase()
	} catch {
		return null
	}
}

/**
 * Whether the dashboard is reachable over the tunnel at all.
 *
 * Absent means disabled: a settings row that has never been touched must not be read as consent,
 * so only a literal `true` opens the tunnel.
 */
export function tunnelDashboardAllowed(settings: unknown): boolean {
	return (settings as Record<string, unknown> | null)?.tunnelDashboardAccess === true
}

/**
 * Whether password login is refused because SSO is the configured method.
 *
 * Returns the SSO type to name in the refusal, or null to allow passwords. An `authMode` of
 * `saml`/`oidc`/`sso` whose provider is *not* configured returns null — a half-finished
 * configuration is not a reason to lock the operator out of their own dashboard.
 */
export function ssoPasswordRefusal(settings: unknown): "saml" | "oidc" | null {
	const row = (settings as Record<string, unknown> | null) ?? {}
	const mode = row.authMode
	if (mode !== "sso" && mode !== "saml" && mode !== "oidc") return null

	const ssoType = row.ssoType === "saml" || mode === "saml" ? "saml" : "oidc"
	if (ssoType === "saml" && row.samlConfigured === true) return "saml"
	if (ssoType === "oidc" && row.oidcConfigured === true) return "oidc"
	return null
}

/** The sentence a refused password login earns. */
export function ssoPasswordRefusalMessage(ssoType: "saml" | "oidc"): string {
	return `Password login is disabled. Use ${ssoType === "saml" ? "SAML SSO" : "OIDC"} sign in.`
}

/** The four facts that decide whether a correct password may still not earn a session. */
export interface DefaultPasswordFacts {
	readonly hasStoredPassword: boolean
	readonly hasInitialPasswordOverride: boolean
	readonly trustedNetwork: boolean
	readonly allowRemoteDefaultLogin: boolean
}

/**
 * Whether a successful password check still may not produce a session.
 *
 * True only when all four hold: no stored hash (a fresh install), no `INITIAL_PASSWORD` override,
 * not from a trusted network, and no explicit `ALLOW_REMOTE_DEFAULT_LOGIN=true`. Each of those is
 * a reason the login is *not* the published default reached by a stranger.
 */
export function mustChangeDefaultPassword(facts: DefaultPasswordFacts): boolean {
	if (facts.hasStoredPassword) return false
	if (facts.hasInitialPasswordOverride) return false
	if (facts.trustedNetwork) return false
	return !facts.allowRemoteDefaultLogin
}

/** The refusal for a remote login with the published default password, and why it cannot self-serve. */
export const DEFAULT_PASSWORD_REFUSAL =
	"The default password only works from the machine running 9Router, or from the same Docker/LAN network. Open localhost there and change it, or start once with INITIAL_PASSWORD. Set ALLOW_REMOTE_DEFAULT_LOGIN=true to allow the first login from anywhere."

/** The reminder appended to every lockout message: the CLI can always reset, the dashboard cannot. */
export const PASSWORD_RESET_HINT =
	"Forgot password? Reset to default via 9Router CLI → Settings → Reset Password to Default."

/** A short, non-sensitive description of what an API key may do, for the audit trail. */
export function permissionsPreview(raw: unknown): string {
	let parsed: unknown = raw
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw || "{}")
		} catch {
			return "unknown permissions"
		}
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return "no permissions"
	}
	const held = Object.entries(parsed as Record<string, unknown>)
		.filter(([, on]) => on === true)
		.map(([name]) => name)
	return held.length ? held.join(", ") : "no permissions"
}

/** How much of a key may appear in an audit row. That table is readable from the dashboard. */
export function keyFingerprint(key: string): string {
	return `${key.slice(0, 8)}…`
}

/**
 * The path a session lands on.
 *
 * A password session is a full admin and always gets `/dashboard`. An API-key session gets the
 * first page its permissions allow, and `null` when they allow none — a loop guard, because
 * redirecting to a page it cannot open bounces straight back to the login form.
 */
export function sessionHomePath(role: unknown, firstAllowed: string | null): string | null {
	if (role !== "apikey") return "/dashboard"
	return firstAllowed
}
