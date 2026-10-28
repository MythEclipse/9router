/**
 * The site-wide theme.
 *
 * Delegates: normalisation and the "a key may read but not write" rule live in
 * `9router-api`. This file keeps only the transport concerns — the cookie the
 * dashboard session is decoded from, and the no-store header, because the value
 * changes the appearance of every page.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

// Public on purpose: ThemeProvider applies it before anyone signs in, and it is
// one non-sensitive value.
export async function GET() {
	try {
		const { theme } = await getUseCases().getTheme()
		return NextResponse.json({ theme }, { headers: { "Cache-Control": "no-store" } })
	} catch {
		// A settings read must never blank the site; the use-case default stands.
		return NextResponse.json({ theme: "glass" }, { status: 200 })
	}
}

export async function POST(request: Request) {
	try {
		const cookieStore = await cookies()
		const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
		const body = await request.json().catch(() => ({}))
		// The role travels with the call because the dashboard cookie is the only
		// place it exists; the use-case decides what the role is allowed to do.
		//
		// `getDashboardAuthSession` returns the raw JWT payload, so `role` arrives
		// as `unknown`. Narrow it here, at the boundary, rather than casting: a
		// non-string claim means no usable role, which the use-case reads as
		// "not signed in".
		const role = typeof session?.role === "string" ? session.role : null
		return NextResponse.json(await getUseCases().setTheme({ role }, body?.theme))
	} catch (error) {
		return toResponse(error)
	}
}
