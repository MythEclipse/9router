import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/providers/[id]/overrides - this provider's header override, plus the
// headers its transport already sends so the panel can pre-fill them.
export async function GET(_request, { params }) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().overrides.get(id))
	} catch (error) {
		console.log("Error getting provider overrides:", error)
		return NextResponse.json({ error: "Failed to get overrides" }, { status: 500 })
	}
}

// PUT /api/providers/[id]/overrides - body: { headers: {name: value} }.
// An empty payload clears the override.
export async function PUT(request, { params }) {
	try {
		const { id } = await params
		const body = await request.json().catch(() => ({}))
		return NextResponse.json(await getUseCases().overrides.set(id, body))
	} catch (error) {
		return failed(error, "Failed to save overrides", "Error saving provider overrides")
	}
}
