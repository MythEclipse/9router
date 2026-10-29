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
 * GET /api/media-providers/tts/deepgram/voices[?lang=en]
 *
 * Each Deepgram TTS voice is one model (`canonical_name` like `aura-2-thalia-en`), and the
 * language is either a `languages` array or only the suffix of that name.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).mediaProviders.deepgramVoices({
				lang: searchParams.get("lang") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch voices", "media-providers/tts/deepgram/voices")
	}
}
