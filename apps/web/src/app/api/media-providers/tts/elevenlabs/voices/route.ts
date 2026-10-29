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
 * GET /api/media-providers/tts/elevenlabs/voices[?lang=en]
 *
 * Reads the stored connection directly, with no auth mutex, so listing never blocks the
 * concurrent TTS inference that does take it.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).mediaProviders.elevenlabsVoices({
				lang: searchParams.get("lang") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch voices", "media-providers/tts/elevenlabs/voices")
	}
}
