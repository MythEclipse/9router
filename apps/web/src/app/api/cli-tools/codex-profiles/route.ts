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
 * Codex profiles — one `~/.codex/<name>.config.toml` per profile.
 *
 * The three verbs map one-to-one onto the three procedures. A missing `~/.codex` is an empty
 * list, not an error: the screen asks this before the operator has made a profile, and a 500
 * there would read as a broken install.
 */
export async function GET() {
	const answer = await (await client()).codexProfiles.list()
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const answer = await (await client()).codexProfiles.write({ body })
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const answer = await (await client()).codexProfiles.remove({ body })
	return NextResponse.json(answer.body, { status: answer.status })
}
