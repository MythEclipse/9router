/**
 * Aliases, the alias editor's own URL.
 *
 * The same use-case serves `/api/models` PUT, so both URLs cannot disagree about what
 * aliases are. The guard denies this path by default, so the session travels with the
 * call even though the handler reads nothing from it.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/** Every alias and the model it resolves to. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).models.aliases.list())
	} catch (error) {
		return failed(error, "Failed to fetch aliases", "Error fetching aliases")
	}
}

/**
 * Point an alias at a model. Re-pointing one tells the key reconciler, so a key that
 * pinned the old target follows the alias.
 */
export async function PUT(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		const result = await (await client()).models.aliases.set({
			model: body?.model,
			alias: body?.alias,
		})
		return NextResponse.json({ success: true, ...result })
	} catch (error) {
		return failed(error, "Failed to update alias", "Error updating alias")
	}
}

// DELETE /api/models/alias?alias=xxx - keys that named it are reported back.
export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await getUseCases().modelAliases.remove(searchParams.get("alias") ?? "")
		return NextResponse.json({
			success: true,
			...(result.keysLeftForReview.length ? { keysLeftForReview: result.keysLeftForReview } : {}),
		})
	} catch (error) {
		return failed(error, "Failed to delete alias", "Error deleting alias")
	}
}
