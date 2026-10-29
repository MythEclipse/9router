import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// Reload the in-process module (picks up an upgraded install without a restart).
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().pxpipe.reload())
	} catch (error) {
		console.error("[API] Failed to reload pxpipe:", error)
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to reload pxpipe",
				code: engineCode(error),
			},
			{ status: 500 },
		)
	}
}

/** The engine's own failure code, when it gave one. */
function engineCode(error: unknown): string {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? (error as { code: unknown }).code
			: undefined
	return typeof code === "string" ? code : "INTERNAL"
}
