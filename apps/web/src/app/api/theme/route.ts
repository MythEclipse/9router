/**
 * The site-wide theme.
 *
 * Delegates: normalisation and the "a key may read but not write" rule live in
 * `9router-api`. This file keeps only the transport concerns — the `no-store` header,
 * because the value changes the appearance of every page, and the fallback that keeps
 * a failed settings read from blanking the site.
 *
 * `GET` deliberately builds a client with no session: the procedure is public (`base`,
 * not `authed`) precisely because `ThemeProvider` applies the theme before anyone
 * signs in. `POST` reads the cookie only so the procedure can read the role off the
 * session — the request body no longer carries one, because a caller that states its
 * own role is not authenticated as that role.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

// Public on purpose: ThemeProvider applies it before anyone signs in, and it is
// one non-sensitive value.
export async function GET() {
	try {
		const client = createApiClient({ session: null, useCases: getUseCases() })
		const { theme } = await client.theme.get()
		return NextResponse.json({ theme }, { headers: { "Cache-Control": "no-store" } })
	} catch {
		// A settings read must never blank the site; the use-case default stands.
		return NextResponse.json({ theme: "glass" }, { status: 200 })
	}
}

export async function POST(request: Request) {
	try {
		const cookieStore = await cookies()
		const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
		// `getDashboardAuthSession` returns the raw JWT payload. `sessionFromClaims` is
		// the one place that decides what a token must name to count as a session, so
		// this route does not carry its own opinion about a blank `userId`.
		const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)
		const body = await request.json().catch(() => ({}))
		const client = createApiClient({ session, useCases: getUseCases() })
		return NextResponse.json(await client.theme.set({ theme: body?.theme }))
	} catch (error) {
		return toResponse(error)
	}
}
