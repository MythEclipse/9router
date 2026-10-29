import { headers } from "next/headers"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * The development/CI stop hook.
 *
 * `domain/shutdown-gate.ts` refuses it in production and requires the shared
 * secret outside it; this file only reads the header and maps the refusal.
 */
export async function POST() {
	const authorization = (await headers()).get("authorization")

	try {
		await getUseCases().shutdownFromHook(authorization)
		return NextResponse.json({ success: true, message: "Shutting down..." })
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unauthorized"
		// Production is a 403 (this deployment may never stop this way); a bad or
		// missing secret is a 401 (you may, with the right credential).
		const status = process.env.NODE_ENV === "production" ? 403 : 401
		return NextResponse.json({ success: false, message }, { status })
	}
}
