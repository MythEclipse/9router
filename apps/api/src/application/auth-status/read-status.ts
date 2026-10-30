/**
 * Reading the dashboard's view of the current session.
 *
 * Three reads and a decision; the decision is the interesting part — whether the caller is signed
 * in. The domain owns what the answer *looks like*; this owns getting the facts and refusing to
 * let a failure become a half-answer.
 */
import {
	type AuthStatus,
	type AuthStatusSettings,
	type PermissionCatalog,
	type SessionClaims,
	type SsoProbes,
	signedInStatus,
	signedOutStatus,
} from "../../domain/auth-status.ts"

export interface AuthStatusPort {
	/** The settings row. Throws when the database is unreachable — which is what we must survive. */
	readonly settings: () => Promise<AuthStatusSettings>
	/** The claims from the auth cookie, or `null` when there is no valid session. */
	readonly session: () => Promise<SessionClaims | null>
}

export interface AuthStatusDeps {
	readonly port: AuthStatusPort
	readonly probes: SsoProbes
	readonly catalog: PermissionCatalog
	readonly homePathFor: (role: string, firstAllowed: string | null) => string | null
	readonly firstAllowedPage: (permissions: readonly string[]) => string | null
	/** Where a failure gets reported. Never rethrown: see the catch below. */
	readonly onFailure?: (error: unknown) => void
}

/** Fallbacks the login page can use when the settings read succeeds but the session does not. */
const NO_HOME_PATH = () => null

export async function readAuthStatus(deps: AuthStatusDeps): Promise<AuthStatus> {
	try {
		const settings = await deps.port.settings()
		const claims = await deps.port.session()

		// No session is not a failure: the login page still needs the SSO flags and labels out of
		// settings to draw itself. It passes `claims: null` so the domain can report
		// `authenticated: false` — the shape stays complete either way.
		if (!claims) {
			return signedInStatus({
				claims: null,
				settings,
				probes: deps.probes,
				catalog: deps.catalog,
				homePathFor: NO_HOME_PATH,
				firstAllowedPage: deps.firstAllowedPage,
			})
		}

		return signedInStatus({
			claims,
			settings,
			probes: deps.probes,
			catalog: deps.catalog,
			homePathFor: deps.homePathFor,
			firstAllowedPage: deps.firstAllowedPage,
		})
	} catch (error) {
		// Swallowed on purpose. This endpoint is called before anything else renders, so throwing
		// would leave the dashboard on a spinner forever. The closed answer tells the client to
		// show the login form, which it can act on.
		deps.onFailure?.(error)
		return signedOutStatus()
	}
}
