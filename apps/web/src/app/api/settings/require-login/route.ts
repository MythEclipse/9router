/**
 * GET /api/settings/require-login — the login gate, as the login page reads it.
 *
 * Answers 200 even when the row cannot be read: this is the endpoint the login screen
 * depends on, and a failure here would lock the operator out of the screen they would use
 * to fix it. That tolerance lives in the use-case, which is why this handler has no catch.
 *
 * Public: the path is on the guard's allow-list, and `loginGate` is the router's one `base`
 * procedure. A login screen cannot present a session to ask whether it needs one.
 */
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	const client = createApiClient({
		session: null,
		useCases: getUseCases(),
		headers: request.headers,
	})
	return NextResponse.json(await client.settings.loginGate())
}
