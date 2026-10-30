import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * What this session is, for the dashboard and the login page.
 *
 * Everything the answer contains — the shape, which fields are present, what a failure looks like
 * — lives in `domain/auth-status.ts` and `application/auth-status/read-status.ts`. This handler
 * builds a client, asks, and serialises. It has no `try`: the use-case answers signed-out instead
 * of throwing, because a page that never receives an answer stays on a spinner forever.
 *
 * `session: null` is deliberate. The procedure is not `authed`, and the auth-status port reads the
 * cookie itself. Resolving the caller here and then 401-ing on a bad cookie would break the one
 * endpoint whose job is to report that the cookie is bad.
 *
 * The `catch` this replaced was not equivalent to the signed-out answer. It returned 17 fields
 * where the success path returned 17 *different* ones, so `role`, `permissions`, `homePath` and
 * `keyId` were absent exactly when a client most needed to tell "signed out" from "server broken".
 */
export async function GET() {
	const client = createApiClient({
		session: null,
		useCases: getUseCases(),
		headers: new Headers(),
	})
	return NextResponse.json(await client.authStatus.read())
}
