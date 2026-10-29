/**
 * POST /api/settings/database/jobs — replace the install in the background.
 *
 * Answers 202 with a poll token, and the token matters: the import replaces the settings
 * row holding the password hash, so a client polling with its password would be told the
 * password was wrong over a restore that had committed.
 *
 * The 202 stays here because it is a statement about this request, not about an import —
 * the use-case answers with a job, not a finished restore.
 */

import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"
import "@/lib/db/registerPostImportHooks"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body) {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
		}
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: request.headers,
		})
		return NextResponse.json(await client.settings.database.startJob(body), { status: 202 })
	} catch (error) {
		return failed(error, "Failed to import database", "Error starting database import job")
	}
}
