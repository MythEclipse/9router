/**
 * Interactive web login: open a headed browser at the provider's login page, let the
 * operator log in by hand, harvest the cookies, auto-create the connection. The cookie
 * never travels back to the client — only a short preview does.
 *
 * Delegates: which providers support this, how a session's cookie becomes a connection,
 * and what the preview may show live in `application/providers/web-login.ts`.
 *
 * The 202 on `POST` stays here: starting a login is not the same as completing one, and
 * that is a statement about this request, not about what a login is.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
	})
}

/** `?provider=x` polls one session; without it, the supported list and saved profiles. */
export async function GET(request: Request) {
	try {
		const provider = new URL(request.url).searchParams.get("provider")
		const api = await client()
		if (!provider) return NextResponse.json(await api.providers.webLogin.available())
		return NextResponse.json(await api.providers.webLogin.status({ provider }))
	} catch (error) {
		return failed(error, "Failed to read login status", "Error reading web login status")
	}
}

/** Body: `{provider, profile?}`. Opens the login window; 202 because it has just begun. */
export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		const api = await client()
		return NextResponse.json(await api.providers.webLogin.begin(body ?? {}), { status: 202 })
	} catch (error) {
		return failed(error, "Failed to start login", "Error starting web login")
	}
}

/** `?provider=x` — cancel a running session. */
export async function DELETE(request: Request) {
	try {
		const provider = new URL(request.url).searchParams.get("provider")
		const api = await client()
		return NextResponse.json(await api.providers.webLogin.abandon({ provider }))
	} catch (error) {
		return failed(error, "Failed to cancel login", "Error cancelling web login")
	}
}
