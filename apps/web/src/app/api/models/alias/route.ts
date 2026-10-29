import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/models/alias - every alias and the model it resolves to.
export async function GET() {
	try {
		return NextResponse.json({ aliases: await getUseCases().modelAliases.list() })
	} catch (error) {
		return failed(error, "Failed to fetch aliases", "Error fetching aliases")
	}
}

// PUT /api/models/alias - point an alias at a model. Re-pointing one tells the
// key reconciler, so a key that pinned the old target follows the alias.
export async function PUT(request) {
	try {
		const body = await request.json()
		const result = await getUseCases().modelAliases.set({ model: body?.model, alias: body?.alias })
		return NextResponse.json({ success: true, ...result })
	} catch (error) {
		return failed(error, "Failed to update alias", "Error updating alias")
	}
}

// DELETE /api/models/alias?alias=xxx - keys that named it are reported back.
export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await getUseCases().modelAliases.remove(searchParams.get("alias") ?? "")
		return NextResponse.json({
			success: true,
			...(result.keysLeftForReview.length ? { keysLeftForReview: result.keysLeftForReview } : {}),
		})
	} catch (error) {
		return failed(error, "Failed to delete alias", "Error deleting alias")
	}
}
