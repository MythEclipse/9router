import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/**
 * /api/headroom/extras - the compression extras.
 *
 * GET lists what is available and installed, or `?log=1` for the live install log the
 * progress poller reads. POST installs, DELETE uninstalls.
 *
 * Install and uninstall carry different error-code sets (see `domain/headroom-lifecycle.ts`):
 * NOT_INSTALLED is a client error for install and meaningless for uninstall, and folding
 * them together would answer 400 for a failure that is actually a fault here.
 */
function extrasOf(body: unknown): unknown[] {
	const extras = (body as { extras?: unknown } | null)?.extras
	return Array.isArray(extras) ? extras : []
}

export async function GET(request: Request) {
	try {
		const log = new URL(request.url).searchParams.get("log") === "1"
		return NextResponse.json(await (await client()).headroom.extras.read({ log }))
	} catch (error) {
		return failed(error, "Failed to read Headroom extras", "headroom/extras")
	}
}

export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		return NextResponse.json(
			await (await client()).headroom.extras.install({ extras: extrasOf(body) }),
		)
	} catch (error) {
		return failed(error, "Failed to install Headroom extras", "headroom/extras")
	}
}

export async function DELETE(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		return NextResponse.json(
			await (await client()).headroom.extras.uninstall({ extras: extrasOf(body) }),
		)
	} catch (error) {
		return failed(error, "Failed to uninstall Headroom extras", "headroom/extras")
	}
}
