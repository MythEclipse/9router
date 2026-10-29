/**
 * /api/settings/auto-backup — the config, the status, and the countdown.
 *
 * A GET here re-arms a scheduler that a restart killed; see the use-case for why a read
 * has that side effect. POST sends one now and answers 200 with `ok: false` on failure, so
 * the screen keeps the provider's own message instead of the generic one a 5xx produces.
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
		return NextResponse.json(await (await client(request)).settings.autoBackup.read())
	} catch (error) {
		return failed(error, "Failed to load auto-backup config", "Error loading auto-backup config")
	}
}

/** PATCH — edit the configuration. */
export async function PATCH(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(await (await client(request)).settings.autoBackup.write(body))
	} catch (error) {
		return failed(error, "Failed to save auto-backup config", "Error saving auto-backup config")
	}
}

/** POST — `{ action: "test", password }` sends one now. */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			action?: unknown
			password?: unknown
		}
		return NextResponse.json(
			await (await client(request)).settings.autoBackup.sendNow({
				action: body?.action,
				password: typeof body?.password === "string" ? body.password : null,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to send test backup", "[Settings][AutoBackup] test send failed")
	}
}
