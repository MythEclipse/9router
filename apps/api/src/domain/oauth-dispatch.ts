/**
 * Which OAuth action a provider supports.
 *
 * The dispatcher route answers ten actions, and most of them are only meaningful for a
 * handful of providers: polling a session, stopping a callback proxy, detecting an installed
 * IDE. The route answered this with a chain of `if (provider === ...)` repeated three times —
 * once for polling, once for stopping, once for starting — and three copies of one rule can
 * disagree. One table, read three times, cannot.
 */

/** The providers that run a local callback proxy with a session the browser polls. */
export const SESSION_PROVIDERS = ["codex", "xai", "trae", "windsurf", "zed", "xiaomi-mimo"] as const

export type SessionProvider = (typeof SESSION_PROVIDERS)[number]

/** The providers whose local IDE install is detectable, for the import-token screen. */
export const IDE_PROVIDERS = ["trae", "windsurf"] as const

/** The one provider whose flow ends with the operator pasting a code back. */
export const MANUAL_CODE_PROVIDER = "xai"

/**
 * Xiaomi's session outlives a finished poll.
 *
 * Unlike every other provider, MiMo does not exchange the code server-side — the client
 * POSTs `/exchange` once polling reports done, and that call is what clears the session. A
 * poll that cleared it, the way the others do, would delete the session just before the
 * exchange that needs it, and the login would fail with "session not found" every time.
 */
export function sessionSurvivesPoll(provider: string): boolean {
	return provider === "xiaomi-mimo"
}

/** Whether a poll can be answered for this provider at all. */
export function canPollSession(provider: string): boolean {
	return (SESSION_PROVIDERS as readonly string[]).includes(provider)
}

/** Whether this provider has a callback proxy to stop. */
export function canStopProxy(provider: string): boolean {
	return canPollSession(provider)
}

/** Whether the local IDE install can be detected for this provider. */
export function canDetectIde(provider: string): boolean {
	return (IDE_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * The message for an action addressed to the wrong provider.
 *
 * Naming the providers that do support it is what turns a dead end into a correction: the
 * dashboard can only offer the right screen if the operator learns what the right screen is.
 */
export function unsupportedActionMessage(action: string, supported: readonly string[]): string {
	const verb =
		action === "poll-status"
			? "Poll only supported for"
			: action === "stop-proxy"
				? "Proxy only supported for"
				: `${action} only supported for`
	return `${verb} ${supported.join("/")}`
}

/**
 * The key a session is stored under.
 *
 * Every provider's session store is keyed by the `state` value its own authorize call handed
 * the browser, and a poll without one cannot find anything. Refusing early keeps the route
 * from reporting "unknown" for a request that never named a session.
 */
export function sessionStateOf(value: string | null): string | null {
	return value && value.trim() ? value.trim() : null
}
