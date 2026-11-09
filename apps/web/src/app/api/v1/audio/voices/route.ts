import { buildErrorBody } from "open-sse/utils/error"
import { getUseCases } from "@/lib/useCases"
import { AI_PROVIDERS } from "@/shared/constants/providers"

export const dynamic = "force-dynamic"

/** A voice entry as the voice catalogue returns it. */
interface VoiceItem {
	id: string
	name?: string
	lang?: string
	locale?: string
	gender?: string
}

/** The catalogue shape for the providers that have their own dashboard endpoint. */
interface CataloguePayload {
	voices?: VoiceItem[]
	byLang?: Record<string, { voices?: VoiceItem[] }>
}

const CORS = { "Access-Control-Allow-Origin": "*" }

// Providers whose catalogue is built by the shared voice use-case. edge-tts and
// local-device read a public catalogue; elevenlabs reads the stored connection.
const CATALOGUE_PROVIDERS = new Set([
	"elevenlabs",
	"deepgram",
	"inworld",
	"edge-tts",
	"local-device",
])

async function readCatalogue(provider: string, lang: string | null): Promise<CataloguePayload> {
	const voices = getUseCases().ttsVoices
	if (provider === "deepgram")
		return (await voices.deepgram({ lang: lang ?? undefined })) as CataloguePayload
	if (provider === "inworld")
		return (await voices.inworld({ lang: lang ?? undefined })) as CataloguePayload
	// The generic listing: edge-tts and local-device by name, elevenlabs from its connection.
	return (await voices.listing({ provider, lang: lang ?? undefined })) as CataloguePayload
}

export async function OPTIONS() {
	return new Response(null, {
		headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
	})
}

// GET /v1/audio/voices?provider={p}[&lang=xx]
// Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
//
// The catalogue is read in-process. It used to be fetched over HTTP from the
// dashboard route at /api/media-providers/tts/voices, which sits behind the
// dashboard session: when login was enabled, an external API-key client reached
// this route, passed its own gate, and then got an internal 401 from a request it
// had no cookie for. Reading the same use-case the dashboard route reads removes
// the hop without putting the dashboard route on the public surface.
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const provider = searchParams.get("provider")
		const lang = searchParams.get("lang")

		if (!provider || !CATALOGUE_PROVIDERS.has(provider)) {
			return Response.json(
				buildErrorBody(400, `provider must be one of: ${[...CATALOGUE_PROVIDERS].join(", ")}`),
				{ status: 400, headers: CORS },
			)
		}

		const data = await readCatalogue(provider, lang)

		// Catalogue shape: { voices } when lang filter, else { byLang, languages }
		const rawVoices = lang
			? data.voices || []
			: Object.values(data.byLang || {}).flatMap((l) => l.voices || [])

		// Use provider alias for /v1/audio/speech model param (matches skill convention e.g. el/, dg/, edge-tts/)
		const alias = AI_PROVIDERS[provider]?.alias || provider
		const data_out = rawVoices.map((v) => ({
			id: v.id,
			name: v.name,
			lang: v.lang || "",
			gender: v.gender || "",
			model: `${alias}/${v.id}`,
		}))

		return Response.json({ object: "list", data: data_out }, { headers: CORS })
	} catch (err) {
		const status = typeof err?.status === "number" ? err.status : 502
		return Response.json(buildErrorBody(status, err.message || "Failed"), { status, headers: CORS })
	}
}
