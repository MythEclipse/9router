import { credentialsFrom } from "9router-api/application/settings/manage-database"
import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"
import "@/lib/db/registerPostImportHooks"

export const dynamic = "force-dynamic"

/**
 * POST /api/settings/database/jobs — replace the install in the background.
 *
 * Answers 202 with a poll token. The token matters: the import replaces the settings
 * row holding the password hash, so a client polling with its password would be
 * told the password was wrong over a restore that had committed.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body) {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
		}
		const job = await getUseCases().database.startJob({
			body,
			credentials: credentialsFrom(request.headers),
			contentLength: request.headers.get("content-length"),
		})
		return NextResponse.json(job, { status: 202 })
	} catch (error) {
		console.log("Error starting database import job:", error)
		return failed(error, "Failed to import database", "Error starting database import job")
	}
}
