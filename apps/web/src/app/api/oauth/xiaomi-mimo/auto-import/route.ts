import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/oauth/xiaomi-mimo/auto-import
 *
 * Reads the credential the provider's own tool already wrote on this machine. A miss is
 * `found: false` with the action to take — "MiMoCode token not found in MiMoCode's auth.json. Please log
 * in to MiMoCode first." — not an error status; nobody has logged in yet is a normal state.
 * Where the search looks, and in what order, lives in `oauthImportHost`.
 */
export async function GET() {
	const result = await getUseCases().credentials.autoImport("xiaomi-mimo")
	return NextResponse.json(result)
}
