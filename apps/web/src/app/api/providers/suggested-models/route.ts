import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/providers/suggested-models - the model picker's suggestions for one
// provider. The filter table and the stored-copy-before-built-in preference live
// in `domain/model-catalogue.ts`; the whole-request ceiling in `suggest-models.ts`.
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const answer = await getUseCases().suggestModels.run({
			url: searchParams.get("url"),
			type: searchParams.get("type"),
		})
		return NextResponse.json({
			data: answer.data,
			...(answer.stale ? { stale: true } : {}),
			...(answer.message ? { error: answer.message } : {}),
			...(answer.syncedAt ? { syncedAt: answer.syncedAt } : {}),
		})
	} catch (error) {
		return failed(error, "Suggested models failed", "Error fetching suggested models")
	}
}
