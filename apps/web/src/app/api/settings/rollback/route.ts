import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { sessionRole } from "@/lib/sessionRole"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/settings/rollback — { id, keys? }
 *
 * Re-applies one stored snapshot. `keys` limits the revert to a subset; without it
 * every key in the snapshot is restored. The snapshot is re-sanitized on the way
 * out, so a history entry cannot resurrect a password or a token.
 *
 * The current settings are recorded first, so an accidental revert is itself
 * revertible and the revert appears in the audit trail like any other change.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			id?: unknown
			keys?: unknown
		}
		const result = await getUseCases().settingsHistory.revert({
			id: String(body?.id ?? ""),
			keys: body?.keys,
			role: await sessionRole(),
		})
		return NextResponse.json({ ok: true, ...result })
	} catch (error) {
		console.log("Error rolling back settings:", error)
		return failed(error, "Failed to roll back settings", "Error rolling back settings")
	}
}
