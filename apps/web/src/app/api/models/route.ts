import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

// GET /api/models - every model the dashboard may pick, with its badges.
// Always dynamic: plugin marks come from settings, which a prerendered response
// would freeze at whatever they were during the build.
export const dynamic = "force-dynamic"

export async function GET() {
	try {
		const { models } = { models: await getUseCases().modelCatalogue.list() }
		return NextResponse.json({ models })
	} catch (error) {
		return failed(error, "Failed to fetch models", "Error fetching models")
	}
}

// PUT /api/models - point an alias at a model. The same use-case serves
// /api/models/alias, so both URLs cannot disagree about what an alias is.
export async function PUT(request) {
	try {
		const body = await request.json()
		const result = await getUseCases().modelAliases.set({ model: body?.model, alias: body?.alias })
		return NextResponse.json({ success: true, ...result })
	} catch (error) {
		return failed(error, "Failed to update alias", "Error updating alias")
	}
}
