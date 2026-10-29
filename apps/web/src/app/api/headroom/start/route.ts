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
 * POST /api/headroom/start - start a local Headroom proxy.
 *
 * A remote URL is refused: it belongs to whoever runs it, and starting a local process would
 * make the dashboard report a healthy proxy that every request bypasses. The gate, the port
 * rule and the failure status live in `domain/headroom-lifecycle.ts`; the answer is 400 when
 * the URL is remote or the install is missing, and the use-case decides which.
 */
export async function POST() {
	try {
		return NextResponse.json(await (await client()).headroom.start())
	} catch (error) {
		return failed(error, "Failed to start Headroom", "headroom/start")
	}
}
