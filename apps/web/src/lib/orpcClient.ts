/**
 * The dashboard's client for the oRPC router.
 *
 * In-process on purpose. `apps/web` already holds the use-cases graph and the
 * session cookie, so a `createRouterClient` call reaches the same procedures the
 * HTTP server exposes without a second network hop, a second session resolution,
 * or an API process that has to be running for the dashboard to work. The HTTP
 * server stays available for anything outside this process; this is the path the
 * dashboard itself uses.
 */
import { createRouterClient } from "@orpc/server"
import type { UseCases } from "9router-api/application/use-cases"
import type { SessionClaims } from "9router-api/presentation/orpc/base"
import { appRouter } from "9router-api/presentation/orpc/router"

/**
 * What a procedure sees as `context.session`; `null` means not logged in.
 *
 * The full claim set, not just `userId`/`email`: a procedure that reports usage
 * narrows it with `usageScopeOf(session)`, which reads `apiKeyFilter` and
 * `allowedModels`. Passing only an identity would leave those undefined and hand an
 * API-key session every key's usage.
 */
export type DashboardSession = SessionClaims

export interface RouterContext {
	readonly session: DashboardSession | null
	readonly useCases: UseCases
	/**
	 * The inbound request's headers, so a procedure can read a credential that is not a
	 * session — the database endpoints use `x-9r-password` / `x-9r-cli-token` /
	 * `x-9r-poll-token`. Required rather than optional: a procedure that reads a credential
	 * must not be able to run against a context that has no headers at all, which would
	 * look like "no password presented" and refuse for the wrong reason. Use `new Headers()`
	 * when a caller genuinely has none.
	 */
	readonly headers: Headers
}

/**
 * Build a client bound to one request's context.
 *
 * A fresh client per call rather than a shared one: the context carries the
 * caller's session, and a cached client would serve the first caller's session to
 * every later one — the exact class of bug the cookie-based design avoids.
 */
export function createApiClient(context: RouterContext) {
	return createRouterClient(appRouter, { context })
}

export type ApiClient = ReturnType<typeof createApiClient>

/**
 * Turn the dashboard's session context into router claims.
 *
 * One function rather than a mapping in each route: the first version of the combos
 * route picked `userId`, `email` and `role` by hand, which dropped `apiKeyFilter`
 * and `allowedModels`. Those are exactly the claims that narrow usage to the caller,
 * so a hand-written mapping is how a scoped route silently becomes an unscoped one.
 *
 * `permissions` is merged in from the *context*, not read off the session: the
 * dashboard computes the effective set (a password session gets `FULL_PERMISSIONS`,
 * a key session gets its own normalised list) and puts it beside the session rather
 * than inside it. Reading `session.permissions` would hand every password session
 * `undefined` where it currently has full rights.
 *
 * Returns `null` when there is no `userId`: a session that names nobody is not a
 * session, and passing an object with a blank id would pass the auth gate.
 */
export function sessionClaimsOf(ctx: unknown): DashboardSession | null {
	const context = ctx as { session?: Record<string, unknown> | null; permissions?: unknown } | null
	const session = context?.session
	if (!session) return null
	const userId = typeof session.userId === "string" ? session.userId.trim() : ""
	if (!userId) return null
	return {
		...session,
		userId,
		email: typeof session.email === "string" ? session.email : userId,
		permissions: ctx === null ? null : (context?.permissions ?? session.permissions ?? null),
	} as DashboardSession
}
