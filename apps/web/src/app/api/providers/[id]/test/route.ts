import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/providers/[id]/test - probe one connection. A missing connection is a
// 404 rather than a failed probe; `check-connection.ts` draws that line.
export async function POST(_request, { params }) {
	try {
		const { id } = await params
		return NextResponse.json(await getUseCases().checkConnection.run(id))
	} catch (error) {
		return failed(error, "Test failed", "Error testing connection")
	}
}
