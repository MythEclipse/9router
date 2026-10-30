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
 * Claude Code settings.
 *
 * Claude Code is configured through an `env` block rather than a provider entry, which is why
 * it has its own procedures instead of joining the sixteen in `cliTools`. The port and the
 * install probe are still supplied on the context — the procedure never touches the filesystem
 * itself, and that is what keeps the use-case testable without one.
 */
export async function GET() {
	const answer = await (await client()).claudeTools.readSettings()
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const answer = await (await client()).claudeTools.writeSettings({ body })
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await (await client()).claudeTools.resetSettings()
	return NextResponse.json(answer.body, { status: answer.status })
}
