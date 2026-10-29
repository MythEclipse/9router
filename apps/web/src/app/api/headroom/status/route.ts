import { headroomUrl } from "9router-api/domain/headroom-lifecycle"
import { NextResponse } from "next/server"
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "@/lib/headroom/detect"
import { getManagedPid } from "@/lib/headroom/process"
import { getSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

/** GET /api/headroom/status - installed, running, and the pid this install manages. */
export async function GET() {
	try {
		const url = headroomUrl(await getSettings(), DEFAULT_HEADROOM_URL)
		const status = await getHeadroomStatus(url)
		return NextResponse.json({ ...status, url, managedPid: getManagedPid() })
	} catch (error) {
		return NextResponse.json({ error: error.message }, { status: 500 })
	}
}
