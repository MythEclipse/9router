import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/providers/[id]/test-models - probe every model this connection can
// reach. The warm-up-then-fan-out rule and the serial case for cookie providers
// live in `domain/model-probe.ts`.
export async function POST(_request, { params }) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().probeModels.run(id))
	} catch (error) {
		return failed(error, "Test failed", "Error testing models")
	}
}
