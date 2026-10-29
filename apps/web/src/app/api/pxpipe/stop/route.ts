import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * "Stop" in library mode drops the in-process module; requests fall back to
 * uncompressed passthrough until it is started again.
 */
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().pxpipe.stop())
	} catch (error) {
		console.error("[API] Failed to stop pxpipe:", error)
		return NextResponse.json({ error: "Failed to stop pxpipe" }, { status: 500 })
	}
}
