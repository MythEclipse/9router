import { passwordResetPatch, passwordResetResponse } from "9router-api/domain/sso-probe"
import { NextResponse } from "next/server"
import { updateSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

/**
 * POST /api/auth/reset-password - clear the stored hash so the default applies again.
 *
 * Local-only: `dashboardGuard` refuses this path from anywhere but loopback, because anyone who can
 * call it takes over the dashboard. The response therefore says only that it worked — the default
 * is not echoed back, and neither is the cleared hash. See `domain/sso-probe.ts`.
 */
export async function POST() {
	try {
		await updateSettings(passwordResetPatch())
		return NextResponse.json(passwordResetResponse())
	} catch (error) {
		return NextResponse.json({ error: error.message }, { status: 500 })
	}
}
