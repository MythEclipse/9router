import {
	canDetectIde,
	canPollSession,
	canStopProxy,
	SESSION_PROVIDERS,
	sessionStateOf,
	sessionSurvivesPoll,
	unsupportedActionMessage,
} from "../../domain/oauth-dispatch.ts"

/**
 * The three session actions of the OAuth dispatcher.
 *
 * The route keeps the HTTP. What lives here is the decision — can this provider answer this
 * action at all, and what happens to a session once it is answered.
 */

/** A session's current state, as one provider's store reports it. */
export interface SessionView {
	readonly status: string
	readonly [key: string]: unknown
}

/** What the session actions need from the host. */
export interface DispatchDeps {
	/** One provider's session, or null when it has never been started. */
	readonly readSession: (provider: string, state: string) => SessionView | null
	/** Forget a session once its work is over. */
	readonly clearSession: (provider: string, state: string) => void
	/** Stop a provider's local callback proxy. */
	readonly stopProxy: (provider: string) => void
	/** Whether the provider's desktop app is installed here. */
	readonly detectIde: (provider: string) => Promise<Record<string, unknown>>
}

/**
 * What an action answers.
 *
 * Flat rather than a union: `apps/web` compiles with `strict: false`, where TypeScript will
 * not narrow a union, so `if (!answer.ok) answer.error` would not compile in the route even
 * though the union is correct. Optional fields keep the decision inside the use-case instead
 * of pushing a cast into every caller.
 */
export interface DispatchAnswer {
	readonly ok: boolean
	readonly status: number
	readonly error?: string
	readonly body?: Record<string, unknown>
}

/**
 * `GET /api/oauth/[provider]/poll-status`.
 *
 * A finished session is cleared for every provider except MiMo, whose exchange happens later
 * in the browser — see `sessionSurvivesPoll`. A pending one is reported with its own status
 * so the waiting screen keeps waiting instead of showing an error.
 */
export async function pollSessionStatus(
	provider: string,
	rawState: string | null,
	deps: DispatchDeps,
): Promise<DispatchAnswer> {
	if (!canPollSession(provider)) {
		return {
			ok: false,
			status: 400,
			error: unsupportedActionMessage("poll-status", SESSION_PROVIDERS),
		}
	}

	const state = sessionStateOf(rawState)
	if (!state) return { ok: false, status: 400, error: "Missing state" }

	const session = deps.readSession(provider, state)
	if (!session) return { ok: true, status: 200, body: { status: "unknown" } }

	if (session.status !== "done" && session.status !== "error") {
		return { ok: true, status: 200, body: { status: session.status } }
	}

	if (sessionSurvivesPoll(provider)) {
		// A failed MiMo session is cleared here because no exchange will ever come for it.
		if (session.status === "error") {
			deps.clearSession(provider, state)
			deps.stopProxy(provider)
		}
		return { ok: true, status: 200, body: { ...session } }
	}

	deps.clearSession(provider, state)
	return { ok: true, status: 200, body: { ...session } }
}

/**
 * `GET /api/oauth/[provider]/stop-proxy`.
 *
 * Stopping is idempotent on purpose: the dashboard calls it on cancel, on unmount and after a
 * completed login, and a stop that failed because the proxy was already gone would surface as
 * an error over a login that had actually worked.
 */
export function stopProviderProxy(provider: string, deps: DispatchDeps): DispatchAnswer {
	if (!canStopProxy(provider)) {
		return {
			ok: false,
			status: 400,
			error: unsupportedActionMessage("stop-proxy", SESSION_PROVIDERS),
		}
	}
	deps.stopProxy(provider)
	return { ok: true, status: 200, body: { success: true } }
}

/**
 * `GET /api/oauth/[provider]/ide-status`.
 *
 * Answers whether the desktop app is here, which the screen uses to choose between "import
 * from your IDE" and "paste a token". A provider without such an app is refused rather than
 * answered with `false`: "not installed" and "not applicable" lead to different screens.
 */
export async function readIdeStatus(provider: string, deps: DispatchDeps): Promise<DispatchAnswer> {
	if (!canDetectIde(provider)) {
		return {
			ok: false,
			status: 400,
			error: unsupportedActionMessage("ide-status", ["trae", "windsurf"]),
		}
	}
	return { ok: true, status: 200, body: await deps.detectIde(provider) }
}
