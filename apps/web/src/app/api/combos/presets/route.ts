/**
 * Combo presets for a client (Cursor, Claude).
 *
 * Which presets exist is a catalog question answered by `apps/web`; creating
 * them is a combo rule owned by `9router-api`. This route joins the two, and the
 * create path goes through the normal `createCombo`, so a preset cannot
 * introduce a name or a cycle the API would reject.
 */
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	try {
		const source = new URL(request.url).searchParams.get("source")
		return NextResponse.json(await getUseCases().previewComboPresets(source))
	} catch (error) {
		return toResponse(error)
	}
}

export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		return NextResponse.json(await getUseCases().createComboPresets(body?.source))
	} catch (error) {
		return toResponse(error)
	}
}
