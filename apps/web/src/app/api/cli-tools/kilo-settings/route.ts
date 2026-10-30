import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/**
 * kilo settings.
 *
 * The host bundle — config port, extra stores, and the three messages — is named in
 * `lib/cliToolRegistry.ts`, not built here. That table is what the oRPC procedure resolves
 * against, so this route and any other caller configure the tool identically.
 */
export async function GET() {
	const answer = await (await client()).cliTools.readSettings({ tool: "kilo" })
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const answer = await (await client()).cliTools.writeSettings({ tool: "kilo", body })
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await (await client()).cliTools.resetSettings({ tool: "kilo" })
	return NextResponse.json(answer.body, { status: answer.status })
}
