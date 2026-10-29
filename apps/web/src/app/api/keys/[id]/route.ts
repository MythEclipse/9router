import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
	})
}

/**
 * The ownership rules and the edit rules live in `domain/key-ownership.ts` and
 * `domain/key-update.ts`. Both handlers used to write the same four ownership
 * checks out inline, in a different order each time.
 *
 * `callerFrom` is gone. It built a caller by hand from `ctx.session` plus
 * `ctx.permissions`, while the router built a second one from a constant claiming
 * every caller was a password session — two answers to one question. Now there is
 * one translation (`callerFromSession`), it runs inside the procedure, and a key
 * session keeps its `apikey` role so the ownership checks apply to it.
 */

/** Map a typed application error onto the reply the dashboard already expects. */
function toRefusal(error: unknown) {
	const code = (error as { code?: string })?.code
	const raw = (error as { message?: unknown })?.message
	const message = typeof raw === "string" ? raw : "Request refused"
	if (code === "FORBIDDEN") return { status: 403, body: { error: message } }
	if (code === "NOT_FOUND") return { status: 404, body: { error: message } }
	if (code === "CONFLICT") return { status: 409, body: { error: message } }
	if (code === "VALIDATION") return { status: 400, body: { error: message } }
	return null
}

// GET /api/keys/[id] - Get single key
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params
		const key = await (await client()).dashboardKeys.get({ id })
		return NextResponse.json({ key })
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) return NextResponse.json(refused.body, { status: refused.status })
		console.log("Error fetching key:", error)
		return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 })
	}
}

// PUT /api/keys/[id] - Update key
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params
		const body = (await request.json().catch(() => ({}))) ?? {}
		const key = await (await client()).dashboardKeys.update({ ...body, id })
		return NextResponse.json({ key })
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) return NextResponse.json(refused.body, { status: refused.status })
		console.log("Error updating key:", error)
		return NextResponse.json({ error: "Failed to update key" }, { status: 500 })
	}
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params
		const result = await (await client()).dashboardKeys.remove({ id })
		return NextResponse.json({ message: result.message })
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) return NextResponse.json(refused.body, { status: refused.status })
		console.log("Error deleting key:", error)
		return NextResponse.json({ error: "Failed to delete key" }, { status: 500 })
	}
}
