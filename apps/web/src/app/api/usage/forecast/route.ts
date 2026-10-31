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

/**
 * The cap as a number, or `undefined` when the caller did not name a usable one.
 *
 * `Number("")` is `0` and `Number("abc")` is `NaN`; both would reach the projection as a cap
 * that silently disables the budget answer instead of being absent. An absent cap is a
 * legitimate request (project the spend, skip the ETA), so it is the only thing that may be
 * passed through.
 */
function capOf(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined
	const cap = Number(value)
	return Number.isFinite(cap) && cap > 0 ? cap : undefined
}

/**
 * GET /api/usage/forecast - what the current daily rate projects for the period.
 *
 * `?cap=` is the budget to measure exhaustion against; the key table already renders that
 * number from `keyBudget`, so the page passes what it shows rather than letting the endpoint
 * form a second opinion about it.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.forecast({
				period: searchParams.get("period") || undefined,
				cap: capOf(searchParams.get("cap")),
			}),
		)
	} catch (error) {
		return failed(error, "Failed to forecast spend", "usage/forecast")
	}
}
