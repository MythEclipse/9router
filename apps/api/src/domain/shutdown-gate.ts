/**
 * Who may stop the server.
 *
 * Two endpoints stop the same process for two different reasons, and each
 * decided its own gate inline:
 *
 * - `version/shutdown` is the dashboard's "stop" button. Password sessions only
 *   — stopping the process is an administrator action, and a key-signed session
 *   reaching it must be told no. The route's comment already said hiding the
 *   button is presentation and this is the rule, but the rule lived in the
 *   handler where nothing could test it without a cookie.
 * - `shutdown` is the development/CI hook, guarded by `SHUTDOWN_SECRET` and
 *   refused outright in production.
 *
 * They are kept separate rather than merged behind one "may shutdown" verdict:
 * they answer different questions (is this an administrator? is this deployment
 * allowed to stop at all?) and a caller passes both.
 */

export type ShutdownRefusal =
	| { readonly allowed: true; readonly message?: never }
	| { readonly allowed: false; readonly message: string }

const ALLOWED: ShutdownRefusal = { allowed: true }

export interface SessionIdentity {
	/** The session's role, or null when there is no session at all. */
	readonly role: string | null
}

/**
 * The dashboard's stop button: a password session, and nothing else.
 *
 * A session that could not be read is treated as anonymous rather than as an
 * error, because the alternative is a 500 that tells an attacker their token
 * was well-formed but unreadable. A session that exists but carries no role is
 * refused for the same reason it is not trusted: `role: null` is not "unknown,
 * allow" but "not established", and stopping the process is irreversible.
 */
export function mayStopFromDashboard(session: SessionIdentity | null): ShutdownRefusal {
	if (session === null) return refuse()
	if (typeof session.role !== "string" || session.role.length === 0) return refuse()
	if (session.role === "apikey") return refuse()
	return ALLOWED
}

/**
 * The CI hook: refused in production, then refused without the shared secret.
 *
 * Production is checked first on purpose. A production box that is missing
 * `SHUTDOWN_SECRET` must not fall through to the secret comparison, where an
 * unset secret and an unset header would compare equal and let any caller stop
 * the server.
 */
export function mayStopFromHook(input: {
	readonly nodeEnv: string | undefined
	readonly secret: string | undefined
	readonly authorization: string | null
}): ShutdownRefusal {
	if (input.nodeEnv === "production") {
		return { allowed: false, message: "Not allowed in production" }
	}
	if (!input.secret) {
		return { allowed: false, message: "Unauthorized" }
	}
	if (input.authorization !== `Bearer ${input.secret}`) {
		return { allowed: false, message: "Unauthorized" }
	}
	return ALLOWED
}

function refuse(): ShutdownRefusal {
	return { allowed: false, message: "Only a password session can shut the server down" }
}
