import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/proxy-pools/[id]/test — prove the egress path works, and record the result.
 *
 * The test writes back: a failing pool becomes inactive so the router stops retrying a
 * known-broken path, and `lastError` is cleared on success.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await context.params
		return NextResponse.json(await getUseCases().proxyPools.test(id))
	} catch (error) {
		console.log("Error testing proxy pool:", error)
		return failed(error, "Failed to test proxy pool", "Error testing proxy pool")
	}
}
