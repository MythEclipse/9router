import { mimoLoginStatus, mimoLoginStatusHttp } from "9router-api/domain/mimo-login"
import { NextResponse } from "next/server"
import {
	attachSessionCookie,
	readSessionIdentity,
	sessionFromRequest,
} from "@/lib/mimoLoginSession"

export const dynamic = "force-dynamic"

/**
 * GET /api/oauth/xiaomi-mimo/login/status?state=...
 * Polls the server-side login session (state lives in the httpOnly session
 * cookie - route handlers and the proxy don't share module memory). When a
 * passToken is in the jar, probes /api/user/xiaomi/me once to confirm the
 * session works, then returns the identity for the client to persist.
 */
export async function GET(request: Request) {
	const state = new URL(request.url).searchParams.get("state") || ""
	const session = sessionFromRequest(request)

	// AUTHORIZATION = passToken in the jar (captured during the proxied login
	// XHRs). No serviceToken exchange - weekly-quota API moved; re-wire later.
	if (session && session.status !== "done" && readSessionIdentity(session)) {
		session.status = "done"
	}

	const identity = session ? readSessionIdentity(session) : null
	const status = mimoLoginStatus({
		sessionPresent: session !== null,
		stateMatches: !state || session?.state === state,
		identityPresent: Boolean(identity),
	})
	const httpStatus = mimoLoginStatusHttp(status)

	if (status === "expired") return NextResponse.json({ status }, { status: httpStatus })
	if (!session) return NextResponse.json({ status }, { status: httpStatus })

	if (status === "pending") {
		// Re-arm the session cookie on every poll - the modal may sit on the login
		// form much longer than the 15min TTL, and only proxied responses used to
		// refresh it (browser silently drops an expired cookie before the POST).
		return attachSessionCookie(
			NextResponse.json({ status, region: session.region }, { status: httpStatus }),
			session,
		)
	}

	if (!identity) {
		return attachSessionCookie(
			NextResponse.json(
				{ status: "error", error: "session captured but passToken missing" },
				{ status: httpStatus },
			),
			session,
		)
	}

	// One-shot: don't let the identity linger past the client reading it.
	const response = NextResponse.json({
		status,
		region: session.region,
		...identity,
	})
	response.cookies.set("9r_mimo_login", "", { path: "/", httpOnly: true, maxAge: 0 })
	return response
}
