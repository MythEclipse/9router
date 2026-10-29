/**
 * One connection: read, update, delete.
 *
 * Delegates: what a connection may hold, and what a name collision means, are rules and
 * live in `9router-api`. The guard denies this path by default, so the session travels
 * with the call.
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
		headers: new Headers(),
	})
}

type IdParams = { params: Promise<{ id: string }> }

/** One connection, secret stripped. */
export async function GET(_request: Request, { params }: IdParams) {
	try {
		const { id } = await params
		return NextResponse.json({ connection: await (await client()).providers.get({ id }) })
	} catch (error) {
		return failed(error, "Failed to fetch connection", "Error fetching connection")
	}
}

/**
 * Update. Every field is optional; absent means "leave it alone", including the proxy
 * and pool fields.
 */
export async function PUT(request: Request, { params }: IdParams) {
	try {
		const { id } = await params
		const changes = await request.json().catch(() => ({}))
		const connection = await (await client()).providers.update({ id, changes })
		return NextResponse.json({ connection })
	} catch (error) {
		if (isNameConflict(error)) {
			return NextResponse.json(nameConflictBody(error), { status: 409 })
		}
		return failed(error, "Failed to update connection", "Error updating connection")
	}
}

export async function DELETE(_request: Request, { params }: IdParams) {
	try {
		const { id } = await params
		await (await client()).providers.remove({ id })
		return NextResponse.json({ message: "Connection deleted successfully" })
	} catch (error) {
		return failed(error, "Failed to delete connection", "Error deleting connection")
	}
}
