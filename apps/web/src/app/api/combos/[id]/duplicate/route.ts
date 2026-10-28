/**
 * Copy a combo.
 *
 * Delegates: naming, copying the contents, and carrying the routing strategy
 * over are all rules, so they live in `9router-api` beside the rest.
 */
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../../../response"

export const dynamic = "force-dynamic"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().duplicateCombo(id), { status: 201 })
	} catch (error) {
		return toResponse(error)
	}
}
