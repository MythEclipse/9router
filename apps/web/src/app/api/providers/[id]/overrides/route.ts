/**
 * This provider's header override, plus the headers its transport already sends so the
 * panel can pre-fill them.
 *
 * Delegates: what an override means, and which headers the transport sends anyway, are
 * rules and live in `9router-api`.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

type IdParams = { params: Promise<{ id: string }> }

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

export async function GET(_request: Request, { params }: IdParams) {
	try {
		const { id } = await params
		return NextResponse.json(await (await client()).providers.overrides.get({ id }))
	} catch (error) {
		return failed(error, "Failed to get overrides", "Error getting provider overrides")
	}
}

/** Body: `{ headers: {name: value} }`. An empty payload clears the override. */
export async function PUT(request: Request, { params }: IdParams) {
	try {
		const { id } = await params
		const body = await request.json().catch(() => ({}))
		return NextResponse.json(
			await (await client()).providers.overrides.set({ id, headers: body?.headers }),
		)
	} catch (error) {
		return failed(error, "Failed to save overrides", "Error saving provider overrides")
	}
}
