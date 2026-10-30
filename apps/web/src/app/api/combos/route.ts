/**
 * Combo collection.
 *
 * Served through the oRPC router rather than calling use-cases directly. Both
 * would work — they reach the same use-case — but going through the router means
 * the REST reply and the oRPC procedure are literally the same code path, so they
 * cannot drift into answering differently about what a valid combo is.
 *
 * The router is called in-process (`createApiClient`), so this adds no HTTP hop
 * and no second session lookup.
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
		headers: new Headers(),
	})
}

export async function GET() {
	try {
		const result = await (await client()).combos.list({})
		// `{ combos }`, not the bare array. Every dashboard caller reads
		// `(await res.json()).combos` — five of them — and each falls back to
		// `|| []`, so unwrapping here does not fail loudly, it empties the page.
		return NextResponse.json(result)
	} catch (error) {
		return toResponse(error)
	}
}

export async function POST(request: Request) {
	try {
		const combo = await (await client()).combos.create(await request.json())
		return NextResponse.json(combo, { status: 201 })
	} catch (error) {
		return toResponse(error)
	}
}
