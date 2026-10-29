import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/models/test - ping one model through the internal completions or
// embeddings path, so the dashboard can show a real result rather than a guess.
export async function POST(request) {
	try {
		const result = await getUseCases().modelProbe.ping(await request.json())
		return NextResponse.json(result)
	} catch (error) {
		return failed(error, "Model test failed", "Model test failed")
	}
}
