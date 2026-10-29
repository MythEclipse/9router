import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** GET /api/proxy-pools — list, optionally filtered and with usage counts. */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(await getUseCases().proxyPools.list(searchParams))
	} catch (error) {
		console.log("Error fetching proxy pools:", error)
		return failed(error, "Failed to fetch proxy pools", "Error fetching proxy pools")
	}
}

/** POST /api/proxy-pools — create one. */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const result = await getUseCases().proxyPools.create(body)
		return NextResponse.json(result, { status: 201 })
	} catch (error) {
		console.log("Error creating proxy pool:", error)
		return failed(error, "Failed to create proxy pool", "Error creating proxy pool")
	}
}
