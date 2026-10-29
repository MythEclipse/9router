import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/oauth/kiro/auto-import
 *
 * Reads the credential the provider's own tool already wrote on this machine. A miss is
 * `found: false` with the action to take — "Kiro token not found in the AWS SSO cache. Please log
 * in to Kiro first." — not an error status; nobody has logged in yet is a normal state.
 * Where the search looks, and in what order, lives in `oauthImportHost`.
 */
export async function GET() {
	const result = await getUseCases().credentials.autoImport("kiro")
	return NextResponse.json(result)
}
