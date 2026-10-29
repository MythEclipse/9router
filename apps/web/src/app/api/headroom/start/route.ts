import {
	externalProxyRefusal,
	headroomFailureStatus,
	headroomStartOptions,
	headroomStartPort,
	headroomUrl,
	START_CLIENT_ERROR_CODES,
} from "9router-api/domain/headroom-lifecycle"
import { NextResponse } from "next/server"
import { DEFAULT_HEADROOM_URL, isLoopbackHeadroomUrl } from "@/lib/headroom/detect"
import { startHeadroomProxy } from "@/lib/headroom/process"
import { getSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

/**
 * POST /api/headroom/start - start a local Headroom proxy.
 *
 * A remote URL is refused: it belongs to whoever runs it, and starting a local process would make
 * the dashboard report a healthy proxy that every request bypasses. The gate, the port rule and
 * the failure status live in `domain/headroom-lifecycle.ts`.
 */
export async function POST() {
	try {
		const settings = await getSettings()
		const url = headroomUrl(settings, DEFAULT_HEADROOM_URL)
		const refusal = externalProxyRefusal(url, isLoopbackHeadroomUrl)
		if (refusal) {
			return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 400 })
		}
		const result = await startHeadroomProxy({
			port: headroomStartPort(url),
			...headroomStartOptions(settings),
		})
		return NextResponse.json({ success: true, ...result })
	} catch (error) {
		return NextResponse.json(
			{ error: error.message, code: error.code || null },
			{ status: headroomFailureStatus(error, START_CLIENT_ERROR_CODES) },
		)
	}
}
