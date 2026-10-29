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
 * GET /api/media-providers/tts/minimax/voices[?provider=minimax|minimax-cn&voice_type=all]
 *
 * MiniMax reports its own failures in the body with HTTP 200, so `base_resp.status_code` is
 * the real verdict — checking only `res.ok` would hand the picker an empty list and no reason
 * why. That check, and the two hosts, live in the use-case; this route only carries the query.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).mediaProviders.minimaxVoices({
				provider: searchParams.get("provider") || undefined,
				voiceType: searchParams.get("voice_type") || undefined,
				lang: searchParams.get("lang") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch MiniMax voices", "media-providers/tts/minimax/voices")
	}
}
