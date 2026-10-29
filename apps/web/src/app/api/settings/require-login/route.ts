import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/require-login — the login gate, as the login page reads it.
 *
 * Answers 200 even when the row cannot be read: this is the endpoint the login
 * screen depends on, and a failure here would lock the operator out of the screen
 * they would use to fix it.
 */
export async function GET() {
	return NextResponse.json(await getUseCases().settings.loginGate())
}
