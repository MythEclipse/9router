/**
 * Reload the in-process engine module, picking up an upgraded install without a
 * process restart.
 *
 * Delegates: what reloading means, and which failures it can raise, are rules and live
 * in `9router-api`. The guard denies this path by default, so the session travels with
 * the call.
 *
 * This is `reload`, not `install` or `start` — those stay on their own REST routes
 * behind the password session, because the oRPC transport is reachable with an API key
 * and an install triggered by a key can change what runs on the host.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST() {
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: new Headers(),
		})
		return NextResponse.json(await client.pxpipe.reload())
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
