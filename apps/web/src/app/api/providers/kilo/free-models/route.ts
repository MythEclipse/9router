import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/providers/kilo/free-models - Kilo's free tier, cached for an hour and
// served stale rather than empty when the upstream refuses.
export async function GET() {
	const result = await getUseCases().freeModels.list()

	switch (result.kind) {
		case "fresh":
			return NextResponse.json({ models: result.models, cached: false })
		case "cached":
			return NextResponse.json({ models: result.models, cached: true })
		case "stale":
			return NextResponse.json({ models: result.models, cached: true, warning: result.warning })
		default:
			return NextResponse.json(
				{ models: [], error: `Failed to fetch Kilo models: ${result.message}` },
				{ status: 502 },
			)
	}
}
