import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/models/custom - every custom model the operator added.
export async function GET() {
	try {
		return NextResponse.json({ models: await getUseCases().customModels.list() })
	} catch (error) {
		return failed(error, "Failed to fetch custom models", "Error fetching custom models")
	}
}

// POST /api/models/custom - capability keys and the STT transport are filtered
// by the domain rule, so a client cannot store a string where a boolean belongs.
export async function POST(request) {
	try {
		const added = await getUseCases().customModels.add(await request.json())
		return NextResponse.json({ success: true, added })
	} catch (error) {
		return failed(error, "Failed to add custom model", "Error adding custom model")
	}
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url)
		const providerAlias = searchParams.get("providerAlias") ?? ""
		const id = searchParams.get("id") ?? ""
		if (!providerAlias || !id) {
			return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 })
		}
		const result = await getUseCases().customModels.remove({
			providerAlias,
			id,
			type: searchParams.get("type") || "llm",
		})
		return NextResponse.json({
			success: true,
			...(result.keysLeftForReview.length ? { keysLeftForReview: result.keysLeftForReview } : {}),
		})
	} catch (error) {
		return failed(error, "Failed to delete custom model", "Error deleting custom model")
	}
}
