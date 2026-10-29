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
import { appRouter } from "9router-api/presentation/orpc/router"

/** What a procedure sees as `context.session`; `null` means not logged in. */
export interface DashboardSession {
	readonly userId: string
	readonly email: string
	readonly role?: string | null
	readonly permissions?: Record<string, boolean> | null
	readonly [claim: string]: unknown
}

export interface RouterContext {
	readonly session: DashboardSession | null
	readonly useCases: UseCases
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
