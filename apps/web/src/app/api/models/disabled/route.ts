/**
 * Models disabled per provider — the "hide these from the picker" list.
 *
 * Delegates: what a disabled entry means, and that an empty list re-enables the whole
 * provider, are rules and live in `9router-api`. The guard denies this path by default,
 * so the session travels with the call.
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
	})
}

/** `?providerAlias=xxx` */
export async function GET(request: Request) {
	try {
		const providerAlias = new URL(request.url).searchParams.get("providerAlias") ?? undefined
		return NextResponse.json(await (await client()).models.disabled.list({ providerAlias }))
	} catch (error) {
		return failed(error, "Failed to fetch disabled models", "Error fetching disabled models")
	}
}

/** Body: `{ providerAlias, ids: [...] }` */
export async function POST(request: Request) {
	try {
		const body = await request.json()
		return NextResponse.json(await (await client()).models.disabled.disable(body))
	} catch (error) {
		// A body that is not JSON used to be a 500 here; it is the caller's error.
		if (error instanceof SyntaxError) {
			return NextResponse.json({ error: "providerAlias and ids[] required" }, { status: 400 })
		}
		return failed(error, "Failed to disable models", "Error disabling models")
	}
}

/**
 * `?providerAlias=xxx[&id=yyy]`
 *
 * Without `id` this re-enables every model for the provider, which is the documented
 * meaning of an empty list rather than a no-op.
 *
 * `providerAlias` is required by the procedure's schema, so a missing one is refused
 * there rather than silently widened to "every provider" here — an empty query must
 * never enable more than it names.
 */
export async function DELETE(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const providerAlias = searchParams.get("providerAlias")
		const id = searchParams.get("id")
		if (providerAlias === null) {
			return NextResponse.json({ error: "providerAlias is required" }, { status: 400 })
		}
		return NextResponse.json(
			await (await client()).models.disabled.enable({
				providerAlias,
				...(id === null ? {} : { id }),
			}),
		)
	} catch (error) {
		return failed(error, "Failed to enable models", "Error enabling models")
	}
}
