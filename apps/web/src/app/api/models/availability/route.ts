import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/models/availability - which models are cooling down and why.
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().modelAvailability.list())
	} catch (error) {
		return failed(error, "Failed to fetch model availability", "Failed to get model availability")
	}
}

// POST /api/models/availability  body: { action: "clearCooldown", provider, model }
export async function POST(request) {
	try {
		const result = await getUseCases().modelAvailability.clearCooldown(await request.json())
		return NextResponse.json({ ok: true, ...result })
	} catch (error) {
		return failed(error, "Failed to clear cooldown", "Failed to clear model cooldown")
	}
}
