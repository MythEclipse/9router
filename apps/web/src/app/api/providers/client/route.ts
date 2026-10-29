import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/providers/client - the connection listing the usage panel reads. The
// disclosure whitelist, usage eligibility and paging live in
// `domain/client-listing.ts`.
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await getUseCases().listClientConnections.run({
				provider: searchParams.get("provider"),
				accountStatus: searchParams.get("accountStatus"),
				sort: searchParams.get("sort"),
				page: searchParams.get("page"),
				pageSize: searchParams.get("pageSize"),
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch providers", "Error fetching providers for client")
	}
}
