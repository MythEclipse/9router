/**
 * Pricing configuration.
 *
 * Delegates: the shape of a valid update, and what a reset target means, are
 * rules and live in `9router-api`. This file keeps the verbs and the query
 * parameters.
 */
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

/** The catalog merged with the operator's overrides. */
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().getPricing())
	} catch (error) {
		return toResponse(error)
	}
}

/** Body: `{ provider: { model: { input, output, cached, reasoning, cache_creation } } }` */
export async function PATCH(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		return NextResponse.json(await getUseCases().updatePricing(body))
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
		const pricing = await getUseCases().resetPricing(
			searchParams.get("provider"),
			searchParams.get("model"),
		)
		return NextResponse.json(pricing)
	} catch (error) {
		return toResponse(error)
	}
}
