import { credentialsFrom } from "9router-api/application/settings/manage-database"
import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"
import "@/lib/db/registerPostImportHooks"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/database/jobs/[jobId] — how far the restore has got.
 *
 * The poll token is checked before the password, because mid-import the password is
 * compared against the row being replaced.
 */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
	try {
		const { jobId } = await context.params
		const progress = await getUseCases().database.readJob({
			jobId,
			credentials: credentialsFrom(request.headers),
		})
		return NextResponse.json(progress)
	} catch (error) {
		console.log("Error reading database import job:", error)
		return failed(error, "Failed to read import job", "Error reading database import job")
	}
}
