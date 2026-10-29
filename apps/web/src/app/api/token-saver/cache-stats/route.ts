import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Hit/miss counters for the response cache.
 *
 * The cache toggle is otherwise unfalsifiable from the UI: there is no way to
 * tell a cache that never hits from one that is saving every repeat prompt.
 * Reading never resets; only POST does.
 */
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().cacheStats.read())
	} catch (error) {
		console.error("[API] Failed to read cache stats:", error)
		return NextResponse.json({ error: "Failed to read cache stats" }, { status: 500 })
	}
}

export async function POST() {
	try {
		return NextResponse.json(await getUseCases().cacheStats.reset())
	} catch (error) {
		console.error("[API] Failed to reset cache stats:", error)
		return NextResponse.json({ error: "Failed to reset cache stats" }, { status: 500 })
	}
}
