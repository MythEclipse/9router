import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

const idOf = async (context: { params: Promise<{ id: string }> }) => (await context.params).id

/** GET /api/proxy-pools/[id] — read one. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		return NextResponse.json(await getUseCases().proxyPools.read(await idOf(context)))
	} catch (error) {
		console.log("Error fetching proxy pool:", error)
		return failed(error, "Failed to fetch proxy pool", "Error fetching proxy pool")
	}
}

/** PUT /api/proxy-pools/[id] — update the fields that were sent. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(await getUseCases().proxyPools.update(await idOf(context), body))
	} catch (error) {
		console.log("Error updating proxy pool:", error)
		return failed(error, "Failed to update proxy pool", "Error updating proxy pool")
	}
}

/**
 * DELETE /api/proxy-pools/[id] — remove one, unless a connection still needs it.
 *
 * The 409 carries how many connections are in the way, so the screen can name them.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		return NextResponse.json(await getUseCases().proxyPools.remove(await idOf(context)))
	} catch (error) {
		console.log("Error deleting proxy pool:", error)
		return failed(error, "Failed to delete proxy pool", "Error deleting proxy pool")
	}
}
