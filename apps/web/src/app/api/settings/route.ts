/**
 * GET /api/settings — every setting, minus the two secrets.
 *
 * Always dynamic and never cached: the response carries no secret, but it does carry the
 * operator's configuration, and a shared cache keyed by URL alone would hand one
 * session's answer to the next.
 *
 * Delegates: which keys are secrets, and which settings are site-wide, live in the use-case.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SETTINGS_RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
}

async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
}

export async function GET(request: Request) {
	try {
		return NextResponse.json(await (await client(request)).settings.read(), {
			headers: SETTINGS_RESPONSE_HEADERS,
		})
	} catch (error) {
		return failed(error, "Failed to read settings", "Error getting settings")
	}
}

export async function PUT(request: Request) {
	return PATCH(request)
}

/**
 * PATCH /api/settings — merge a change into the settings row.
 *
 * The role travels with the session rather than being decided here: the rule that an
 * API-key session may not write a site-wide setting belongs beside the list of site-wide
 * settings, not in a handler.
 */
export async function PATCH(request: Request) {
	try {
		const body = (await request.json()) as Record<string, unknown>
		return NextResponse.json(await (await client(request)).settings.write(body), {
			headers: SETTINGS_RESPONSE_HEADERS,
		})
	} catch (error) {
		return failed(error, "Failed to update settings", "Error updating settings")
	}
}
