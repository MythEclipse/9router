/**
 * The before-images of the last settings mutations.
 *
 * Part of the security trail: "what did this install look like just before that change" is
 * the question a revert asks first. Delegates: capping the list, and which entries an
 * API-key session may see, live in the use-case.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
}

export async function GET(request: Request) {
	try {
		const { history, total } = await (await client(request)).settings.history.list()
		return NextResponse.json({ history, total }, { headers: { "Cache-Control": "no-store" } })
	} catch (error) {
		return failed(error, "Failed to load settings history", "Error listing settings history")
	}
}

/**
 * POST /api/settings/history — one entry in full, so a revert can be previewed.
 *
 * A POST that reads is not a mistake: the id travels in the body so it stays out of the
 * URL, and the answer carries the whole configuration that entry would restore.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as { id?: unknown }
		return NextResponse.json(
			await (await client(request)).settings.history.read({ id: String(body?.id ?? "") }),
		)
	} catch (error) {
		return failed(error, "Failed to read settings history", "Error reading settings history")
	}
}
