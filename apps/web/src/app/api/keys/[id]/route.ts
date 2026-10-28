import { DEFAULT_PERMISSIONS, getSessionContext } from "@9router/auth/dashboardPermissions"
import { asKeyPermissions } from "9router-api/domain/sub-key-scope"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * The ownership rules and the edit rules live in `domain/key-ownership.ts` and
 * `domain/key-update.ts`. Both handlers used to write the same four ownership
 * checks out inline, in a different order each time.
 */
function callerFrom(ctx) {
	return {
		role: ctx.session?.role ?? null,
		apiKey: ctx.session?.role === "apikey" ? (ctx.session.apiKey ?? null) : null,
		keyName: ctx.session?.keyName ?? null,
		keyId: ctx.session?.keyId ?? null,
		permissions: asKeyPermissions(ctx.permissions) ?? asKeyPermissions(DEFAULT_PERMISSIONS),
		scope: {
			tokenLimit: ctx.session?.tokenLimit ?? null,
			dailyCostLimit: ctx.session?.dailyCostLimit ?? null,
			allowedModels: ctx.session?.allowedModels ?? null,
			allowedEndpoints: Array.isArray(ctx.session?.allowedEndpoints)
				? ctx.session.allowedEndpoints
				: null,
		},
	}
}

/** Map a typed application error onto the reply the dashboard already expects. */
function toRefusal(error) {
	const code = error?.code
	const message = typeof error?.message === "string" ? error.message : "Request refused"
	if (code === "FORBIDDEN") return { status: 403, body: { error: message } }
	if (code === "NOT_FOUND") return { status: 404, body: { error: message } }
	if (code === "CONFLICT") return { status: 409, body: { error: message } }
	if (code === "VALIDATION") return { status: 400, body: { error: message } }
	return null
}

// GET /api/keys/[id] - Get single key
export async function GET(_request, { params }) {
	try {
		const { id } = await params
		const ctx = await getSessionContext()
		const key = await getUseCases().singleKey.get(id, callerFrom(ctx))
		return NextResponse.json({ key })
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) return NextResponse.json(refused.body, { status: refused.status })
		console.log("Error fetching key:", error)
		return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 })
	}
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
	try {
		const { id } = await params
		const ctx = await getSessionContext()
		const body = (await request.json().catch(() => ({}))) ?? {}
		const key = await getUseCases().singleKey.update(id, body, callerFrom(ctx))
		return NextResponse.json({ key })
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) return NextResponse.json(refused.body, { status: refused.status })
		console.log("Error updating key:", error)
		return NextResponse.json({ error: "Failed to update key" }, { status: 500 })
	}
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(_request, { params }) {
	try {
		const { id } = await params
		const ctx = await getSessionContext()
		await getUseCases().singleKey.remove(id, callerFrom(ctx))
		return NextResponse.json({ message: "Key deleted successfully" })
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) return NextResponse.json(refused.body, { status: refused.status })
		console.log("Error deleting key:", error)
		return NextResponse.json({ error: "Failed to delete key" }, { status: 500 })
	}
}
