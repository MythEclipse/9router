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
 * GET /api/media-providers/tts/voices
 *   ?provider=edge-tts | local-device | elevenlabs | gemini  (default: edge-tts)
 *   ?lang=en     (optional filter by lang code)
 *   ?apiKey=xxx  (required for elevenlabs)
 *
 * The three payload shapes differ in where the language and the country live, not in what the
 * picker needs, so each branch reshapes one entry and the grouping stays in the domain.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).mediaProviders.mediaVoices({
				provider: searchParams.get("provider") || undefined,
				lang: searchParams.get("lang") || undefined,
				apiKey: searchParams.get("apiKey") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch voices", "media-providers/tts/voices")
	}
}
