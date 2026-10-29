import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** POST /api/proxy-pools/{slug}-deploy — deploy a relay and register it as a pool. */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const result = await getUseCases().proxyPools.deploy("vercel", body)
		return NextResponse.json(result, { status: 201 })
	} catch (error) {
		console.log("Error deploying Vercel relay:", error)
		return failed(error, "Deploy failed", "Error deploying Vercel relay")
	}
}
