/**
 * PATCH /api/keys/bulk - { ids: [...], patch: { ... } }
 *
 * The password-only gate, the editable-field whitelist, the 500-key cap and the
 * per-key outcome are all in `domain/bulk-key-edit.ts` and its use-case. This route
 * shapes the reply.
 *
 * It reads the session the same way it always has — straight from the cookie rather
 * than through `getSessionContext()` — because `mayBulkEdit` branches on `role`
 * alone, and the context helper's extra permission normalisation is not part of this
 * endpoint's contract. The caller is still built inside the procedure by
 * `callerFromSession`, so a key session arrives as `apikey` instead of the
 * `"admin"` the router used to assume for everyone.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request) {
	try {
		const cookieStore = await cookies()
		const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
		// The verified payload is a JWT body, not a session: `sessionFromClaims` is the
		// one place that decides what a token must name to count as one, so this route
		// does not get its own opinion about whether a blank `userId` is logged in.
		const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)

		const client = createApiClient({ session, useCases: getUseCases(), headers: request.headers })
		const body: unknown = await request.json().catch(() => ({}))
		const fields = (body ?? {}) as { ids?: unknown; patch?: unknown }
		const result = await client.dashboardKeys.bulkEdit({ ids: fields.ids, patch: fields.patch })

		return NextResponse.json({
			updated: result.updated,
			missing: result.missing,
			failed: result.failed,
		})
	} catch (error) {
		const refused = toRefusal(error)
		if (refused) {
			return NextResponse.json({ error: refused.message }, { status: refused.status })
		}
		console.log("Error in bulk key update:", error)
		return NextResponse.json({ error: "Failed to bulk update keys" }, { status: 500 })
	}
}

function toRefusal(error: unknown) {
	const code = (error as { code?: string })?.code
	const raw = (error as { message?: unknown })?.message
	const message = typeof raw === "string" ? raw : "Request refused"
	if (code === "FORBIDDEN") return { status: 403, message }
	if (code === "VALIDATION") return { status: 400, message }
	return null
}
