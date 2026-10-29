import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/codex/bulk-import
 *
 * Imports the accounts an export file holds: a bare array, a single object, or
 * `{ accounts: [...] }`. Each row is written or refused on its own — one bad entry does not
 * throw away the ones that were fine, and the response says which index failed and why.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importBatch({
			provider: "codex",
			body: await request.json(),
		})
		return NextResponse.json(result)
	} catch (error) {
		return failed(error, "Codex bulk import failed", "oauth/codex/bulk-import")
	}
}
