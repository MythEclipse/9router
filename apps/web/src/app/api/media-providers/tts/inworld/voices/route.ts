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
 * GET /api/media-providers/tts/inworld/voices[?lang=en]
 *
 * Every Inworld voice carries `languages: [...]`; a voice with none is still usable and is
 * listed under the custom bucket rather than dropped.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).mediaProviders.inworldVoices({
				lang: searchParams.get("lang") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch voices", "media-providers/tts/inworld/voices")
	}
}
