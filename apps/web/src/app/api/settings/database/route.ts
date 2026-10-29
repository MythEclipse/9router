import { credentialsFrom } from "9router-api/application/settings/manage-database"
import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/database — the whole install, or a summary of it.
 *
 * `?summary=true` needs no credential: it is what the login screen reads before
 * anyone has signed in.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const payload = await getUseCases().database.read({
			searchParams,
			credentials: credentialsFrom(request.headers),
			contentLength: request.headers.get("content-length"),
		})
		return NextResponse.json(payload)
	} catch (error) {
		console.log("Error exporting database:", error)
		return failed(error, "Failed to export database", "Error exporting database")
	}
}

/**
 * POST /api/settings/database — replace the install, synchronously.
 *
 * The body carries both the password and the database, so the browser posts it as
 * JSON rather than a form. The use-case removes the password before writing.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const result = await getUseCases().database.write({
			body,
			credentials: credentialsFrom(request.headers),
		})
		return NextResponse.json(result)
	} catch (error) {
		console.log("Error importing database:", error)
		return failed(error, "Failed to import database", "Error importing database")
	}
}
