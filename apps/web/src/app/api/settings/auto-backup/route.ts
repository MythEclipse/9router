import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/auto-backup — the config, the status, and the countdown.
 *
 * This read re-arms a scheduler that a restart killed. See the use-case for why.
 */
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().autoBackup.read())
	} catch (error) {
		console.log("Error loading auto-backup config:", error)
		return failed(error, "Failed to load auto-backup config", "Error loading auto-backup config")
	}
}

/** PATCH /api/settings/auto-backup — edit the configuration. */
export async function PATCH(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(await getUseCases().autoBackup.write(body))
	} catch (error) {
		console.log("Error saving auto-backup config:", error)
		return failed(error, "Failed to save auto-backup config", "Error saving auto-backup config")
	}
}

/**
 * POST /api/settings/auto-backup — { action: "test", password } sends one now.
 *
 * A failed send answers 200 with `ok: false`, so the screen keeps the provider's own
 * message instead of the generic one a 5xx would produce.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			action?: unknown
			password?: unknown
		}
		const result = await getUseCases().autoBackup.sendNow({
			action: body?.action,
			password: typeof body?.password === "string" ? body.password : null,
		})
		return NextResponse.json(result)
	} catch (error) {
		console.log("[Settings][AutoBackup] test send failed:", error)
		return failed(error, "Failed to send test backup", "[Settings][AutoBackup] test send failed")
	}
}
