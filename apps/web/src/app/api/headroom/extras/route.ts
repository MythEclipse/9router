import {
	headroomFailureStatus,
	INSTALL_CLIENT_ERROR_CODES,
	UNINSTALL_CLIENT_ERROR_CODES,
} from "9router-api/domain/headroom-lifecycle"
import { NextResponse } from "next/server"
import {
	findPython310,
	getInstalledHeadroomExtras,
	HEADROOM_COMPRESSION_EXTRAS,
} from "@/lib/headroom/detect"
import {
	getInstallLogTail,
	installHeadroomExtras,
	uninstallHeadroomExtras,
} from "@/lib/headroom/process"

export const dynamic = "force-dynamic"

/**
 * GET /api/headroom/extras - which compression extras are installed.
 * POST - install; DELETE - uninstall. `?log=1` returns the live log tail for progress polling.
 *
 * Install and uninstall carry different error-code sets (see `domain/headroom-lifecycle.ts`):
 * NOT_INSTALLED is a client error for install and meaningless for uninstall, and folding them
 * together would answer 400 for a failure that is actually a fault here.
 */
function requestedExtras(body: unknown): unknown[] {
	const extras = (body as { extras?: unknown } | null)?.extras
	return Array.isArray(extras) ? extras : []
}

export async function GET(req) {
	try {
		if (new URL(req.url).searchParams.get("log") === "1") {
			return NextResponse.json({ log: getInstallLogTail() })
		}
		const python = findPython310()
		const status = getInstalledHeadroomExtras(python)
		return NextResponse.json({
			available: HEADROOM_COMPRESSION_EXTRAS,
			...status,
		})
	} catch (error) {
		return NextResponse.json({ error: error.message }, { status: 500 })
	}
}

export async function POST(req) {
	try {
		const result = await installHeadroomExtras(requestedExtras(await req.json().catch(() => ({}))))
		return NextResponse.json(result)
	} catch (error) {
		return NextResponse.json(
			{ error: error.message, code: error.code || null },
			{ status: headroomFailureStatus(error, INSTALL_CLIENT_ERROR_CODES) },
		)
	}
}

export async function DELETE(req) {
	try {
		const body = await req.json().catch(() => ({}))
		const result = await uninstallHeadroomExtras(requestedExtras(body))
		return NextResponse.json(result)
	} catch (error) {
		return NextResponse.json(
			{ error: error.message, code: error.code || null },
			{ status: headroomFailureStatus(error, UNINSTALL_CLIENT_ERROR_CODES) },
		)
	}
}
