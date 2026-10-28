/**
 * Combo collection.
 *
 * The rules live in `9router-api`; this file only adapts HTTP to them, so the
 * REST route and the oRPC procedure cannot disagree about what a valid combo is.
 */
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

export async function GET() {
	try {
		return NextResponse.json(await getUseCases().listCombos())
	} catch (error) {
		return toResponse(error)
	}
}

export async function POST(request: Request) {
	try {
		const combo = await getUseCases().createCombo(await request.json())
		return NextResponse.json(combo, { status: 201 })
	} catch (error) {
		return toResponse(error)
	}
}
