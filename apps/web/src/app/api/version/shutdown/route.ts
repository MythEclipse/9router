import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Stop the app and its managed background processes.
 *
 * Password sessions only: stopping the process is an administrator action, and a
 * key-signed session must reach this endpoint only to be told no — hiding the
 * button in the menu is presentation, `domain/shutdown-gate.ts` is the rule.
 *
 * The database is closed before the process exits so SQLite is never killed
 * mid-write, and the response is sent before exiting so the dashboard sees a 200
 * rather than a connection reset.
 */
export async function POST() {
	const session = await readSession()
	try {
		await getUseCases().shutdownFromDashboard(session)
		return NextResponse.json({ success: true, message: "Shutting down..." })
	} catch (error) {
		// A refused session is a 403 with the rule's own wording, not a 500.
		const message =
			error instanceof Error ? error.message : "Only a password session can shut the server down"
		return NextResponse.json({ success: false, message }, { status: 403 })
	}
}

/**
 * An unreadable cookie yields `null`, which the rule refuses. Reading it must not
 * produce a 500: that would tell a caller their token parsed but the lookup failed.
 */
async function readSession() {
	try {
		const cookieStore = await cookies()
		const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
		if (!session) return null
		// The session type is `unknown`-typed on the web side; the gate decides what
		// a usable role is, so only the string-ness is settled here.
		const role = (session as { role?: unknown }).role
		return { role: typeof role === "string" ? role : null }
	} catch {
		return null
	}
}
