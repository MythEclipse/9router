import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { createProviderConnection } from "@/models"

export const dynamic = "force-dynamic"

/**
 * iFlow Cookie-Based Authentication
 * POST /api/oauth/iflow/cookie
 * Body: { cookie: "BXAuth=xxx; ..." }
 */
export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}

	const answer = await getUseCases().oauth.importIflowCookie(body, {
		fetchImpl: fetch,
		createConnection: createProviderConnection,
	})

	return NextResponse.json(answer.body, { status: answer.status })
}
