import { headroomStopStatus } from "9router-api/domain/headroom-lifecycle"
import { NextResponse } from "next/server"
import { stopHeadroomProxy } from "@/lib/headroom/process"

export const dynamic = "force-dynamic"

/**
 * POST /api/headroom/stop - stop the managed Headroom proxy.
 *
 * Nothing to stop is 409, not 200: the caller asked for a state change that did not happen, and
 * answering 200 leaves the dashboard showing "stopped" for a proxy it never had.
 */
export async function POST() {
	try {
		const result = stopHeadroomProxy()
		return NextResponse.json({ ...result }, { status: headroomStopStatus(result) })
	} catch (error) {
		return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 })
	}
}
