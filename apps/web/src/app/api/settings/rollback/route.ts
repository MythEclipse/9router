/**
 * POST /api/settings/rollback — { id, keys? }
 *
 * Re-applies one stored snapshot. `keys` limits the revert to a subset; without it every
 * key in the snapshot is restored. The snapshot is re-sanitized on the way out, so a
 * history entry cannot resurrect a password or a token, and the current settings are
 * recorded first — an accidental revert is itself revertible and appears in the audit
 * trail like any other change.
 *
 * Delegates all three of those to `settingsHistory.revert`, which also adds the `ok` field.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as { id?: unknown; keys?: unknown }
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: request.headers,
		})
		return NextResponse.json(
			await client.settings.history.revert({ id: String(body?.id ?? ""), keys: body?.keys }),
		)
	} catch (error) {
		return failed(error, "Failed to roll back settings", "Error rolling back settings")
	}
}
