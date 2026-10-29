import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"
// npm install can legitimately take minutes on a cold cache.
export const maxDuration = 300

// Install (or repair — same operation, reinstalls @latest) then re-run health.
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().pxpipe.install())
	} catch (error) {
		console.error("[API] Failed to install pxpipe:", error)
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to install pxpipe",
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
