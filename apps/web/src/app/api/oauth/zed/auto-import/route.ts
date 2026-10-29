import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/oauth/zed/auto-import
 *
 * Reads the credential the provider's own tool already wrote on this machine. A miss is
 * `found: false` with the action to take — "Zed token not found in Zed's keyring entry. Please log
 * in to Zed first." — not an error status; nobody has logged in yet is a normal state.
 * Where the search looks, and in what order, lives in `oauthImportHost`.
 */
export async function GET() {
	const result = await getUseCases().credentials.autoImport("zed")
	return NextResponse.json(result)
}
