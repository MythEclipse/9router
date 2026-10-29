/**
 * The engine's recent log lines.
 *
 * Delegates: how many lines a `?limit=` asks for, and how they are framed, are rules
 * and live in `9router-api`. The guard denies this path by default, so the session
 * travels with the call even though the handler reads nothing from it.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	try {
		const limit = new URL(request.url).searchParams.get("limit") ?? undefined
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.pxpipe.logs({ limit }))
	} catch (error) {
		console.error("[API] Failed to read pxpipe logs:", error)
		return NextResponse.json({ error: "Failed to read pxpipe logs" }, { status: 500 })
	}
}
