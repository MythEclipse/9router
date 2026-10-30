/**
 * Resolving a dashboard session from a request's cookie.
 *
 * The dashboard's session is a **signed JWT in the `auth_token` cookie**, not a
 * better-auth session. It has to be, because two processes read the same cookie:
 * `apps/web` (which sets it at login) and this API (which must authorise against
 * it). Anything that keeps session state in memory in one process is invisible to
 * the other.
 *
 * The signing secret is therefore the whole contract between them: it is read from
 * `JWT_SECRET` when set, and otherwise from `<DATA_DIR>/jwt-secret`, the file the
 * first process to start generates. Both processes must point at the same
 * `DATA_DIR` — that is the configuration this module depends on and the one thing
 * an operator can get wrong.
 *
 * The header names and claim shapes mirror `packages/auth`, which owns login. This
 * module deliberately does not import it: that package needs `next/headers` to read
 * cookies, and an API that only sees a raw `Cookie` header must not drag the Next
 * request context into its own.
 */
import type { jwtVerify } from "jose"

/** The cookie the dashboard session travels in. */
export const AUTH_TOKEN_COOKIE = "auth_token"

/** Claims this API relies on. Anything else in the token is passed through untouched. */
export interface DashboardSession {
	readonly userId: string
	readonly email: string
	/** `apikey` marks a session created by logging in with an API key rather than the password. */
	readonly role?: string | null
	readonly apiKey?: string | null
	readonly keyName?: string | null
	readonly keyId?: string | null
	readonly tokenLimit?: number | null
	readonly dailyCostLimit?: number | null
	readonly allowedModels?: string | null
	readonly allowedEndpoints?: readonly string[] | null
	readonly permissions?: Record<string, boolean> | null
}

/**
 * Read one cookie out of a raw `Cookie` header.
 *
 * Splitting on `;` is correct because a cookie value cannot contain one. The value
 * is returned verbatim — a JWT's padding is part of it, so nothing beyond the
 * surrounding whitespace is trimmed.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
	if (!header) return null
	for (const part of header.split(";")) {
		const separator = part.indexOf("=")
		if (separator < 0) continue
		if (part.slice(0, separator).trim() !== name) continue
		return part.slice(separator + 1).trim() || null
	}
	return null
}

/**
 * Turn a verified JWT payload into the session this API authorises against.
 *
 * A legacy token that verifies with the old `authenticated` claim is migrated to
 * the single dashboard owner. Other tokens that carry no `userId` are not
 * sessions: signature validity alone does not establish an identity.
 * `email` falls back to the user id so a caller's display path never renders
 * `undefined`.
 */
export function sessionFromClaims(payload: Record<string, unknown>): DashboardSession | null {
	const userId =
		typeof payload.userId === "string" && payload.userId.trim()
			? payload.userId.trim()
			: payload.authenticated === true
				? "dashboard"
				: ""
	if (!userId) return null
	const email = typeof payload.email === "string" ? payload.email.trim() : ""
	return {
		...payload,
		userId,
		email: email || userId,
	} as DashboardSession
}

/**
 * Resolve the caller's session from a raw `Cookie` header.
 *
 * Returns `null` for every failure — absent cookie, malformed token, bad signature,
 * expired — because to a caller they are the same answer: not logged in. Making
 * them distinguishable would let an unauthenticated probe learn whether a guess
 * happened to have a valid signature.
 *
 * `jwtVerify` is given the secret as bytes, matching how the signer keys HS256. The
 * algorithm is pinned: without an explicit `algorithms`, a token that declares
 * `alg: "none"` is a well-known accepted-by-default forgery.
 */
export async function resolveSession(
	cookieHeader: string | null | undefined,
	secret: string,
	verify: typeof jwtVerify,
): Promise<DashboardSession | null> {
	const token = readCookie(cookieHeader, AUTH_TOKEN_COOKIE)
	if (!token) return null
	try {
		const { payload } = await verify(token, new TextEncoder().encode(secret), {
			algorithms: ["HS256"],
		})
		return sessionFromClaims(payload as Record<string, unknown>)
	} catch {
		return null
	}
}
