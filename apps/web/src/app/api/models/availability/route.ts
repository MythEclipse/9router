/**
 * Which models are cooling down and why, plus the control that clears one.
 *
 * Delegates: what counts as unavailable, and what clearing a cooldown restores, are
 * rules and live in `9router-api`. The guard denies this path by default, so the
 * session travels with the call.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/** Which models are cooling down and why. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).models.availability.list())
	} catch (error) {
		return failed(error, "Failed to fetch model availability", "Failed to get model availability")
	}
}

/** Body: `{ action: "clearCooldown", provider, model }`. */
export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		const result = await (await client()).models.availability.clearCooldown(body)
		return NextResponse.json({ ok: true, ...result })
	} catch (error) {
		return failed(error, "Failed to clear cooldown", "Failed to clear model cooldown")
	}
}
