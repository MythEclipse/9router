import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/providers/test-batch - probe every active connection in a group.
// Which connections a group covers lives in `domain/batch-selection.ts`; the row
// shape and its counts in `domain/batch-result.ts`.
export async function POST(request) {
	try {
		const body = await request.json()
		return NextResponse.json(await getUseCases().testConnections.run(body ?? {}))
	} catch (error) {
		return failed(error, "Batch test failed", "Error in batch test")
	}
}
