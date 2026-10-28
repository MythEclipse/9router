/**
 * One combo, by id.
 *
 * Rules live in `9router-api`; this adapts HTTP to them.
 */
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../../response"

export const dynamic = "force-dynamic"

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().getCombo(id))
	} catch (error) {
		return toResponse(error)
	}
}

export async function PUT(request: Request, { params }: Params) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().updateCombo(id, await request.json()))
	} catch (error) {
		return toResponse(error)
	}
}

export async function DELETE(_request: Request, { params }: Params) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().deleteCombo(id))
	} catch (error) {
		return toResponse(error)
	}
}
