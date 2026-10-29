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
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

async function client() {
	const ctx = await getSessionContext()
	const session = ctx.session as { userId?: string; email?: string; role?: string | null } | null
	return createApiClient({
		// The router only reads `userId`/`email` to decide whether a caller is logged
		// in; anything else the dashboard session carries is passed through.
		session: session?.userId
			? {
					userId: String(session.userId),
					email: String(session.email ?? ""),
					role: session.role ?? null,
				}
			: null,
		useCases: getUseCases(),
	})
}

export async function GET() {
	try {
		const result = await (await client()).combos.list({})
		// The procedure answers `{ combos: [...] }`; the REST contract has always
		// been the bare array, and the dashboard reads it that way.
		return NextResponse.json(result.combos)
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
