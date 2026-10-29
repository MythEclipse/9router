/**
 * The provider list and connection creation.
 *
 * Delegates: which connections exist, what may be created, and when a name collides are
 * rules, and live in `9router-api`. The guard denies this path by default, so the session
 * travels with the call even though neither handler reads one.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { isNameConflict, nameConflictBody } from "@/lib/providerConflicts"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
	})
}

/** Every connection, secrets stripped, compatible ones named after their node. */
export async function GET() {
	try {
		return NextResponse.json({ connections: await (await client()).providers.list() })
	} catch (error) {
		console.log("Error fetching providers:", error)
		return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 })
	}
}

/**
 * Create a connection (API key only; OAuth has its own flow).
 *
 * A POST carrying an id edits that connection; without one, a name collision is refused
 * with 409 rather than silently replacing a key.
 */
export async function POST(request: Request) {
	try {
		const connection = await (await client()).providers.create(await request.json().catch(() => ({})))
		return NextResponse.json({ connection }, { status: 201 })
	} catch (error) {
		if (isNameConflict(error)) {
			return NextResponse.json(nameConflictBody(error), { status: 409 })
		}
		return failed(error, "Failed to create provider", "Error creating provider")
	}
}
