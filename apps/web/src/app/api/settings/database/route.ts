/**
 * /api/settings/database — the whole install, or a summary of it.
 *
 * `?summary=true` needs no credential: it is what the login screen reads before anyone has
 * signed in. That ordering lives in `manage-database.ts`, which is why the raw query string
 * is passed through rather than parsed here.
 *
 * The password, CLI token and poll token travel in headers, never in the body — the
 * procedure reads them off the request itself, so a caller cannot claim `cli: true`.
 */

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

export async function GET(request: Request) {
	try {
		const searchParams = new URL(request.url).searchParams.toString()
		return NextResponse.json(await (await client(request)).settings.database.read({ searchParams }))
	} catch (error) {
		return failed(error, "Failed to export database", "Error exporting database")
	}
}

/**
 * POST — replace the install, synchronously.
 *
 * The body carries both the password and the database, so the browser posts it as JSON
 * rather than a form. The use-case removes the password before writing.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(await (await client(request)).settings.database.write(body))
	} catch (error) {
		return failed(error, "Failed to import database", "Error importing database")
	}
}
