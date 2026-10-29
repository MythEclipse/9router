import { NextResponse } from "next/server"
import { isNameConflict, nameConflictBody } from "@/lib/providerConflicts"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/providers/[id] - one connection, secret stripped.
export async function GET(_request, { params }) {
	try {
		const { id } = await params
		return NextResponse.json({ connection: await getUseCases().connections.get(id) })
	} catch (error) {
		return failed(error, "Failed to fetch connection", "Error fetching connection")
	}
}

// PUT /api/providers/[id] - update. Every field is optional; absent means "leave
// it alone", including the proxy and pool fields.
export async function PUT(request, { params }) {
	try {
		const { id } = await params
		const connection = await getUseCases().connections.update(id, await request.json())
		return NextResponse.json({ connection })
	} catch (error) {
		if (isNameConflict(error)) {
			return NextResponse.json(nameConflictBody(error), { status: 409 })
		}
		return failed(error, "Failed to update connection", "Error updating connection")
	}
}

// DELETE /api/providers/[id]
export async function DELETE(_request, { params }) {
	try {
		const { id } = await params
		await getUseCases().connections.remove(id)
		return NextResponse.json({ message: "Connection deleted successfully" })
	} catch (error) {
		return failed(error, "Failed to delete connection", "Error deleting connection")
	}
}
