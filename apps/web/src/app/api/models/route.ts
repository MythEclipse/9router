/**
 * The model catalogue and alias editing.
 *
 * Delegates: which models exist, which badges they carry, and what an alias may point
 * at are rules, and live in `9router-api`.
 *
 * Neither handler reads the session, and neither path is public: `dashboardGuard`
 * denies `/api/*` by default and `/api/models` is not on its allow-list. So the client
 * carries the session because the procedures are `authed` — the guard answering 401
 * first does not make it safe to call them anonymously.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

// Always dynamic: plugin marks come from settings, which a prerendered response
// would freeze at whatever they were during the build.
export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/** Every model the dashboard may pick, with its badges. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).models.list())
	} catch (error) {
		return failed(error, "Failed to fetch models", "Error fetching models")
	}
}

/**
 * Point an alias at a model.
 *
 * The same use-case serves `/api/models/alias`, so both URLs cannot disagree about
 * what an alias is.
 */
export async function PUT(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		const result = await (await client()).models.aliases.set({
			model: body?.model,
			alias: body?.alias,
		})
		return NextResponse.json({ success: true, ...result })
	} catch (error) {
		return failed(error, "Failed to update alias", "Error updating alias")
	}
}
