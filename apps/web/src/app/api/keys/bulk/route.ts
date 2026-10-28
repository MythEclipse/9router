import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * PATCH /api/keys/bulk - { ids: [...], patch: { ... } }
 *
 * The password-only gate, the editable-field whitelist, the 500-key cap and the
 * per-key outcome are all in `domain/bulk-key-edit.ts` and its use-case. This
 * route resolves the session and shapes the reply.
 */
export async function PATCH(request) {
	try {
		const cookieStore = await cookies()
		const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)

		const body: unknown = await request.json().catch(() => ({}))
		const fields = (body ?? {}) as { ids?: unknown; patch?: unknown }
		const result = await getUseCases().bulkEditKeys.update(
			{ ids: fields.ids, patch: fields.patch },
			{ role: typeof session?.role === "string" ? session.role : null },
		)

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

function toRefusal(error) {
	const code = error?.code
	const message = typeof error?.message === "string" ? error.message : "Request refused"
	if (code === "FORBIDDEN") return { status: 403, message }
	if (code === "VALIDATION") return { status: 400, message }
	return null
}
