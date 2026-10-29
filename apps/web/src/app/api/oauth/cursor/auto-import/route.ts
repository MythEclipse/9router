import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/oauth/cursor/auto-import
 *
 * Cursor's auth is a SQLite database, not a file: the read is a ladder — bundled binding,
 * then the `sqlite3` binary, then a paste box. A database that is there but unreadable is
 * `windowsManual`, so the screen offers the box; a database that is absent lists the paths
 * that were tried, so the operator can see where to look.
 */
export async function GET() {
	const result = await getUseCases().credentials.autoImportCursor()
	return NextResponse.json(result)
}
