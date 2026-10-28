/**
 * Stored diagnostics.
 *
 * Delegates: the page-size rule and the "did the delete actually happen" check
 * are rules, so they live in `9router-api`. The `success` envelope stays
 * because the dashboard reads that field.
 */
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const page = await getUseCases().listErrorLogs(searchParams.get("limit") ?? undefined)
		return NextResponse.json({ success: true, ...page })
	} catch (error) {
		return toResponse(error)
	}
}

export async function DELETE() {
	try {
		return NextResponse.json({ success: true, ...(await getUseCases().clearErrorLogs()) })
	} catch (error) {
		return toResponse(error)
	}
}
