import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/provider-nodes - every compatible endpoint the operator added.
export async function GET() {
	try {
		return NextResponse.json({ nodes: await getUseCases().providerNodes.list() })
	} catch (error) {
		return failed(error, "Failed to fetch provider nodes", "Error fetching provider nodes")
	}
}

// POST /api/provider-nodes - create. An omitted type is refused, not defaulted:
// silently assuming openai-compatible created phantom nodes from callers that
// never meant to add one.
export async function POST(request) {
	try {
		const node = await getUseCases().providerNodes.create(await request.json())
		return NextResponse.json({ node }, { status: 201 })
	} catch (error) {
		return failed(error, "Failed to create provider node", "Error creating provider node")
	}
}

// PATCH /api/provider-nodes - full update by id in the body. Kept as a distinct
// verb for older clients; it runs the same use-case as PUT /[id].
export async function PATCH(request) {
	try {
		const body = await request.json()
		const { id, ...fields } = body ?? {}
		if (!id) return NextResponse.json({ error: "Node ID is required" }, { status: 400 })
		const node = await getUseCases().providerNodes.update(String(id), fields)
		return NextResponse.json({ node })
	} catch (error) {
		return failed(error, "Failed to update provider node", "Error updating provider node")
	}
}
