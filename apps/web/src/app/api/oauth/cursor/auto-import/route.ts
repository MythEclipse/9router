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

/**
 * GET /api/oauth/cursor/auto-import
 *
 * Cursor's auth is a SQLite database, not a file: the read is a ladder — bundled binding,
 * then the `sqlite3` binary, then a paste box. A database that is there but unreadable is
 * `windowsManual`, so the screen offers the box; a database that is absent lists the paths
 * that were tried, so the operator can see where to look.
 */
export async function GET(request: Request) {
	try {
		return NextResponse.json(await (await client(request)).oauth.cursorAutoImport())
	} catch (error) {
		return failed(error, "Cursor auto-import failed", "oauth/cursor/auto-import")
	}
}
