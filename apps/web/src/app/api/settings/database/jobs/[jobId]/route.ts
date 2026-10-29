/**
 * GET /api/settings/database/jobs/[jobId] — how far the restore has got.
 *
 * The poll token is checked before the password, because mid-import the password is
 * compared against the row being replaced. That order lives in `manage-database.ts`; this
 * handler only carries the token through from the request headers.
 */

import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"
import "@/lib/db/registerPostImportHooks"

export const dynamic = "force-dynamic"

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
	try {
		const { jobId } = await context.params
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: request.headers,
		})
		return NextResponse.json(await client.settings.database.readJob({ jobId }))
	} catch (error) {
		return failed(error, "Failed to read import job", "Error reading database import job")
	}
}
