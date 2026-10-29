/**
 * Pricing configuration.
 *
 * Delegates: the shape of a valid update, and what a reset target means, are rules
 * and live in `9router-api`. This file keeps the verbs and the query parameters.
 *
 * No handler reads the session because no rule here needs a caller — but the path is
 * not public: `dashboardGuard` denies `/api/*` by default and `/api/pricing` is not on
 * its allow-list. The client is built with the session anyway, because the procedures
 * are `authed` and the guard is not a substitute for that gate.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
	})
}

/** The catalog merged with the operator's overrides. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).pricing.get())
	} catch (error) {
		return toResponse(error)
	}
}

/** Body: `{ provider: { model: { input, output, cached, reasoning, cache_creation } } }` */
export async function PATCH(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		return NextResponse.json(await (await client()).pricing.update(body))
	} catch (error) {
		return toResponse(error)
	}
}

/**
 * Reset overrides. `?provider=` alone resets every model for that provider;
 * naming a model without a provider is refused rather than treated as a reset
 * of everything.
 */
export async function DELETE(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const pricing = await (await client()).pricing.reset({
			provider: searchParams.get("provider"),
			model: searchParams.get("model"),
		})
		return NextResponse.json(pricing)
	} catch (error) {
		return toResponse(error)
	}
}
