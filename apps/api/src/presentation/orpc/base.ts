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
 * `apiKeyFilter` and `allowedModels` are here because a procedure that reports
 * usage must narrow to the caller. Leaving them off this type is what pushed the
 * usage router into a hardcoded `{ apiKeyFilter: null, allowedModels: "*" }` — a
 * constant that widens an API-key session's view from its own usage to every key's.
 * A field missing from the context type is a field every procedure invents a default
 * for, and the safe default is not the convenient one.
 *
 * They are optional because a password session carries neither: it may see
 * everything, which `usageScopeOf` already expresses as `null` and `"*"`.
 */
export interface SessionClaims {
	readonly userId: string
	readonly email: string
	readonly role?: string | null
	/** Set when the caller signed in with an API key; narrows usage to that key. */
	readonly apiKeyFilter?: unknown
	/** The models this caller may use; `"*"` or absent means all. */
	readonly allowedModels?: unknown
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
