import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/model-editor - the studio (virtual) models.
export async function GET() {
	try {
		return NextResponse.json({ models: await getUseCases().studioModels.list() })
	} catch (error) {
		return failed(error, "Failed to fetch models", "Error fetching virtual models")
	}
}

// POST /api/model-editor - create { callName, targetModel, displayName?, ... }
export async function POST(request) {
	try {
		const model = await getUseCases().studioModels.create(await request.json())
		return NextResponse.json({ model })
	} catch (error) {
		return failed(error, "Failed to create model", "Error creating virtual model")
	}
}

// PUT /api/model-editor - rename or re-point { callName, previousName?, ... }
export async function PUT(request) {
	try {
		const model = await getUseCases().studioModels.update(await request.json())
		return NextResponse.json({ model })
	} catch (error) {
		return failed(error, "Failed to update model", "Error updating virtual model")
	}
}

// DELETE /api/model-editor?name=xxx
export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await getUseCases().studioModels.remove(searchParams.get("name") ?? "")
		return NextResponse.json({
			success: true,
			...(result.keysLeftForReview.length ? { keysLeftForReview: result.keysLeftForReview } : {}),
		})
	} catch (error) {
		return failed(error, "Failed to delete model", "Error deleting virtual model")
	}
}
