import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * The rules live in `domain/custom-plugins.ts` and the use-case; this file only
 * translates transport. The shapes are unchanged: `{ customPlugins }` for both
 * verbs, `Cache-Control: no-store` on the read because the answer is live state.
 */
export async function GET() {
	try {
		const { customPlugins } = await getUseCases().readPlugins()
		return NextResponse.json({ customPlugins }, { headers: { "Cache-Control": "no-store" } })
	} catch (error) {
		console.error("[API] Failed to read custom plugins:", error)
		return NextResponse.json({ error: "Failed to read custom plugins" }, { status: 500 })
	}
}

export async function PUT(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid customPlugins payload" }, { status: 400 })
	}

	try {
		const result = await getUseCases().writePlugins(body)
		return NextResponse.json({ success: true, customPlugins: result.customPlugins })
	} catch (error) {
		// A refused payload is the caller's fault, and the rule already worded why.
		if (isAppError(error, "VALIDATION")) {
			return NextResponse.json({ error: error.message }, { status: 400 })
		}
		console.error("[API] Failed to update custom plugins:", error)
		return NextResponse.json({ error: "Failed to update custom plugins" }, { status: 500 })
	}
}

function isAppError(error: unknown, code: string): error is { message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === code
	)
}
