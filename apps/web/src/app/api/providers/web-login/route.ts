import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Interactive web login: open a headed browser at the provider's login page, let
 * the operator log in by hand, harvest the cookies, auto-create the connection.
 * The cookie never travels back to the client — only a short preview does. */

// GET /api/providers/web-login            → supported providers and saved profiles
// GET /api/providers/web-login?provider=x → session status, saving once on success
export async function GET(request) {
	try {
		const provider = request.nextUrl.searchParams.get("provider")
		if (!provider) return NextResponse.json(getUseCases().webLogin.available())
		return NextResponse.json(await getUseCases().webLogin.status(provider))
	} catch (error) {
		return failed(error, "Failed to read login status", "Error reading web login status")
	}
}

// POST /api/providers/web-login {provider, profile?} → start the login window
export async function POST(request) {
	try {
		const body = await request.json()
		return NextResponse.json(await getUseCases().webLogin.begin(body ?? {}), { status: 202 })
	} catch (error) {
		return failed(error, "Failed to start login", "Error starting web login")
	}
}

// DELETE /api/providers/web-login?provider=x → cancel a running session
export async function DELETE(request) {
	try {
		const provider = request.nextUrl.searchParams.get("provider")
		return NextResponse.json(getUseCases().webLogin.abandon(provider))
	} catch (error) {
		return failed(error, "Failed to cancel login", "Error cancelling web login")
	}
}
