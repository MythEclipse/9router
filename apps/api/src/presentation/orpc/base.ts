/**
 * Base builder and middleware every procedure shares.
 *
 * oRPC 1.x has no router-level `.use()`, so cross-cutting concerns are applied
 * per procedure here and every router starts from this builder. Auth is
 * attached BEFORE the input schema: an unauthenticated caller must get 401, not
 * a 400 that hands them the shape of a schema they have no right to probe.
 *
 * Ordering bites twice in here, both times because oRPC middleware does not
 * rethrow a downstream error into the *calling* middleware's `try/catch`:
 *
 *  - `authed` therefore starts from `base`, so the error boundary is already
 *    inside the chain and sees the failure.
 *  - The guard THROWS an ORPCError rather than an AppError, because the
 *    boundary maps AppError and would otherwise have nothing to map.
 */
import { ORPCError, os } from "@orpc/server"
import type { UseCases } from "../../application/use-cases.ts"
import { toORPCError } from "./error-mapping.ts"

/**
 * What a procedure may read from the caller's session.
 *
 * A field missing from this type is a field every procedure invents a default for,
 * and the convenient default is never the safe one. Both routers that carried a
 * constant instead of a session prove it:
 *
 *  - `usage` hardcoded `{ apiKeyFilter: null, allowedModels: "*" }`, which widens an
 *    API-key session's view from its own usage to every key's.
 *  - `dashboard-keys` hardcoded the caller as `{ role: "admin", permissions: null }`,
 *    which clears the sub-key escalation gate and lets a key session grant itself
 *    permissions that `domain/sub-key-scope.ts` exists to refuse.
 *
 * So the whole identity lives here, not just enough of it to render a page. The
 * fields are optional because a password session genuinely carries none of them —
 * a real absence, which the domain rules already read as "unrestricted".
 */
export interface SessionClaims {
	readonly userId: string
	readonly email: string
	/**
	 * `apikey` marks a caller authenticated by a key rather than the password. Every
	 * rule that distinguishes the two branches on this exact string, so a procedure
	 * that substitutes `"admin"` silences all of them at once.
	 */
	readonly role?: string | null
	/** The caller's own key, present only when `role` is `apikey`. */
	readonly apiKey?: string | null
	readonly keyName?: string | null
	readonly keyId?: string | null
	/** Set when the caller signed in with an API key; narrows usage to that key. */
	readonly apiKeyFilter?: unknown
	/** The models this caller may use; `"*"` or absent means all. */
	readonly allowedModels?: unknown
	/** Caps inherited by keys this caller creates. */
	readonly tokenLimit?: unknown
	readonly dailyCostLimit?: unknown
	/** The endpoints this caller may reach; `null` means no restriction. */
	readonly allowedEndpoints?: unknown
	/** What the caller itself may do; `null` for a password session. */
	readonly permissions?: unknown
}

export interface RequestContext {
	/** Resolved by the auth middleware; `null` on routes that allow anonymous. */
	readonly session: SessionClaims | null
}

export interface AppContext extends RequestContext {
	readonly useCases: UseCases
}

/** Anything thrown below presentation becomes a typed ORPCError exactly once. */
const errorBoundary = os.middleware(async ({ next }) => {
	try {
		return await next()
	} catch (error) {
		// An ORPCError is already typed; rewrapping it would turn a deliberate
		// 401 into a 500.
		if (error instanceof ORPCError) throw error
		throw toORPCError(error)
	}
})

/** Every procedure starts here. */
export const base = os.$context<AppContext>().use(errorBoundary)

/** Gate for dashboard procedures. Built on `base` so the boundary wraps it. */
export const authed = base.use(async ({ context, next }) => {
	if (!context.session) {
		throw new ORPCError("UNAUTHORIZED", { status: 401, message: "Authentication required" })
	}
	return next({ context: { ...context, session: context.session } })
})
