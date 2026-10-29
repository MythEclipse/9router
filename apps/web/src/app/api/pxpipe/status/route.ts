import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET() {
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.pxpipe.status())
	} catch (error) {
		console.error("[API] Failed to read pxpipe status:", error)
		return NextResponse.json({ error: "Failed to read pxpipe status" }, { status: 500 })
	}
}
