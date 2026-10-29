import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// PUT /api/provider-nodes/[id] - update. The node's connections carry a copy of
// its prefix and base URL, so the use-case patches both; updating the node alone
// leaves every connection routing to the old prefix.
export async function PUT(request, { params }) {
	try {
		const { id } = await params
		const body = await request.json()
		const node = await getUseCases().providerNodes.update(String(id), body ?? {})
		return NextResponse.json({ node })
	} catch (error) {
		return failed(error, "Failed to update provider node", "Error updating provider node")
	}
}

// DELETE /api/provider-nodes/[id] - a node's connections are its children, so
// deleting it takes them with it.
export async function DELETE(_request, { params }) {
	try {
		const { id } = await params
		await getUseCases().providerNodes.remove(String(id))
		return NextResponse.json({ success: true })
	} catch (error) {
		return failed(error, "Failed to delete provider node", "Error deleting provider node")
	}
}
