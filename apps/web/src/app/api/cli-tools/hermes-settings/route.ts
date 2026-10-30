import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Hermes Agent settings, per profile.
 *
 * The profile arrives as `?profile=` on the screen's links and in the body on the CLI's
 * quick-setup; the procedure resolves which one wins. `?applyToAll=1` refreshes the endpoint on
 * every profile that already points here, and reports — never rewrites — the ones that do not.
 */
async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
}

const profileParam = (request: Request): string | null =>
	new URL(request.url).searchParams.get("profile")

export async function GET(request: Request) {
	const answer = await (await client(request)).hermes.readSettings({
		profile: profileParam(request),
	})
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const query = new URL(request.url).searchParams
	// `applyToAll` is accepted from either place, exactly as it was before: the CLI posts it,
	// the screen links with it.
	if (query.get("applyToAll") === "1" || query.get("applyToAll") === "true") {
		body = { ...(body as Record<string, unknown>), applyToAll: true }
	}
	const answer = await (await client(request)).hermes.writeSettings({
		body,
		profile: query.get("profile"),
	})
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE(request: Request) {
	let body: unknown = null
	try {
		body = await request.json()
	} catch {
		// The CLI reset sends an empty body, which means the default profile.
		body = null
	}
	const answer = await (await client(request)).hermes.resetSettings({
		body,
		profile: profileParam(request),
	})
	return NextResponse.json(answer.body, { status: answer.status })
}
