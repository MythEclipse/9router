import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/providers/validate - ask the provider whether a pasted key works.
// What each provider's HTTP status proves about the key lives in
// `domain/credential-verdict.ts`; the per-provider probe requests in
// `application/providers/validate-credential.ts`.
export async function POST(request) {
	try {
		const body = await request.json()
		return NextResponse.json(await getUseCases().validateCredential.run(body ?? {}))
	} catch (error) {
		return failed(error, "Validation failed", "Error validating API key")
	}
}
