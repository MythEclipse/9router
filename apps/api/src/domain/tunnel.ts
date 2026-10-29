/**
 * Rules for the tunnel routes: Cloudflare tunnels and Tailscale funnels.
 *
 * Seven routes, three shapes. `status` answers probes, four verbs turn a tunnel on or off
 * and then re-arm monitoring, one route reports what Tailscale looks like on this machine,
 * and the installer streams progress. These rules are what the shapes have in common, kept
 * here so the seven handlers cannot each invent their own answer.
 */

/** Which service a tunnel verb acts on. */
export const TUNNEL_KINDS = ["cloudflare", "tailscale"] as const

export type TunnelKind = (typeof TUNNEL_KINDS)[number]

/**
 * How long `status` may reuse its last probes, in milliseconds.
 *
 * The dashboard polls while a tunnel is being brought up, and each poll otherwise probes
 * the process and the network. Download progress is deliberately *not* cached: it is the
 * number the operator watches move.
 */
export const STATUS_CACHE_TTL_MS = 3_000

/**
 * How long to wait after a Cloudflare tunnel registers before answering, in milliseconds.
 *
 * The tunnel's hostname resolves at Cloudflare's edge, not here, so a dashboard that
 * switched to the URL immediately would show a DNS failure for its first seconds. Waiting
 * is a guess, but it is a guess made once, at the point where the operator is already
 * watching a spinner.
 */
export const DNS_WARMUP_DELAY_MS = 8_000

/**
 * Whether cached probes may be reused for a poll that arrives at `now`.
 *
 * A clock that moved backwards counts as stale. Reusing an entry whose timestamp is in the
 * future would freeze the panel until the clock caught up, and the cause — a machine that
 * slept or had its time corrected — is nowhere near the symptom.
 */
export function statusIsFresh(fetchedAt: number, now: number): boolean {
	if (fetchedAt <= 0) return false
	const age = now - fetchedAt
	return age >= 0 && age < STATUS_CACHE_TTL_MS
}

/**
 * What the Tailscale check route answers.
 *
 * `daemonRunning` is the union of the two ways the daemon can run — the bundled binary on
 * its own socket, or the system service — because the screens only ask "can I talk to it".
 * The two are reported separately as well, so a machine where the custom daemon failed but
 * the system one is alive does not read as a plain success.
 */
export interface TailscaleCheckAnswer {
	readonly installed: boolean
	readonly loggedIn: boolean
	readonly platform: string
	readonly brewAvailable: boolean
	readonly daemonRunning: boolean
	readonly customDaemonRunning: boolean
	readonly systemDaemonRunning: boolean
	readonly hasCachedPassword: boolean
}

/**
 * Whether installing Tailscale needs the operator's sudo password.
 *
 * Windows has no sudo, and a Homebrew install runs as the user, so neither needs it. Every
 * other platform does — and asking for a password that is not needed is a prompt the
 * operator cannot satisfy on a machine that never had one.
 */
export function installNeedsPassword(platform: string, brewAvailable: boolean): boolean {
	if (platform === "win32") return false
	if (platform === "darwin" && brewAvailable) return false
	return true
}

/**
 * The password to install with, or why the request cannot proceed.
 *
 * A password the operator typed wins over the cached one: they typed it because the cached
 * one was wrong. Falling back to the cache is what lets the second attempt work after a
 * password was saved.
 */
export function installPasswordOf(input: {
	readonly sent: unknown
	readonly cached: string | null
	readonly required: boolean
}): { password: string } | { error: string } {
	const sent = typeof input.sent === "string" ? input.sent.trim() : ""
	if (sent) return { password: sent }
	if (!input.required) return { password: input.cached ?? "" }

	const fallback = (input.cached ?? "").trim()
	if (fallback) return { password: fallback }
	return { error: "Sudo password is required" }
}

/**
 * The message shown for a failed install.
 *
 * `sudo` answers "Sorry, try again." and Homebrew's prompt does too; neither says which
 * password was wrong. Reporting the operator's own wording sends them looking at the
 * network instead of the field they filled in.
 */
export function installFailureOf(message: string | undefined): string {
	const text = message ?? "Install failed"
	if (/incorrect password/i.test(text) || /Sorry/i.test(text)) return "Wrong sudo password"
	return text
}
