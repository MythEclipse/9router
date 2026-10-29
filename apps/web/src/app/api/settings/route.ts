import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { sessionRole } from "@/lib/sessionRole"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SETTINGS_RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
}

/**
 * GET /api/settings — every setting, minus the two secrets.
 *
 * Always dynamic and never cached: the response carries no secret, but it does
 * carry the operator's configuration, and a shared cache keyed by URL alone would
 * hand one session's answer to the next.
 */
export async function GET() {
	try {
		const settings = await getUseCases().settings.read()
		return NextResponse.json(settings, { headers: SETTINGS_RESPONSE_HEADERS })
	} catch (error) {
		console.log("Error getting settings:", error)
		return failed(error, "Failed to read settings", "Error getting settings")
	}
}

export async function PUT(request: Request) {
	return PATCH(request)
}

/**
 * PATCH /api/settings — merge a change into the settings row.
 *
 * The role is read here and passed in, rather than checked here: the rule that an
 * API-key session may not write a site-wide setting belongs beside the list of
 * site-wide settings, not in a handler.
 */
export async function PATCH(request: Request) {
	try {
		const body = (await request.json()) as Record<string, unknown>
		const settings = await getUseCases().settings.write({ body, role: await sessionRole() })
		return NextResponse.json(settings, { headers: SETTINGS_RESPONSE_HEADERS })
	} catch (error) {
		console.log("Error updating settings:", error)
		return failed(error, "Failed to update settings", "Error updating settings")
	}
}
