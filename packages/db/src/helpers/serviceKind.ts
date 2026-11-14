/**
 * Which service lane one usage row belongs to.
 *
 * `saveRequestUsage` is the single write path for every lane the gateway
 * serves — chat, embeddings, System One decisions, images, speech — so a row
 * carries no lane marker of its own. The endpoint the caller hit is the only
 * thing that tells them apart, which is why the live stream classifies from it
 * instead of guessing by model name.
 *
 * Ids mirror MEDIA_PROVIDER_KINDS in the dashboard, so a lane is called the
 * same thing in the usage stream as it is on the provider pages.
 */
export const SERVICE_KINDS = [
	"llm",
	"embedding",
	"image",
	"imageToText",
	"tts",
	"stt",
	"music",
	"video",
	"webSearch",
	"webFetch",
	"systemone",
	"other",
] as const

export type ServiceKind = (typeof SERVICE_KINDS)[number]

/**
 * Reduce a recorded endpoint to a bare path.
 *
 * Handlers store `url.pathname`, so this is usually already `/api/v1/...`; an
 * absolute URL or a query string would otherwise miss every pattern below. The
 * `/api` prefix is stripped because Next rewrites `/v1/*` to `/api/v1/*`, which
 * means the same lane arrives under both names.
 */
function normalizePath(endpoint: unknown): string {
	if (typeof endpoint !== "string") return ""
	return endpoint
		.trim()
		.toLowerCase()
		.split(/[?#]/)[0]
		.replace(/^[a-z]+:\/\/[^/]+/, "")
		.replace(/^\/api(?=\/v1(?:beta)?(?:\/|$))/, "")
		.replace(/^\/v1\/v1(?=\/|$)/, "/v1")
}

/** The lane a usage row belongs to, from the endpoint it was recorded under. */
export function serviceKindOf(endpoint: unknown): ServiceKind {
	const path = normalizePath(endpoint)
	// No endpoint at all: every row written before handlers started recording one
	// was a chat row, so the LLM lane is the honest default rather than "other".
	if (!path) return "llm"
	// A few failure paths record the literal "chat" instead of a path.
	if (path === "chat") return "llm"
	if (/\/(?:chat\/completions|completions|messages|responses|codex|api\/chat)(?:\/|$)/.test(path))
		return "llm"
	if (/\/embeddings(?:\/|$)/.test(path)) return "embedding"
	// Image-to-text first: `/images/understanding` must not fall into the
	// text-to-image lane below.
	if (/\/images\/(?:understanding|image-to-text)(?:\/|$)/.test(path)) return "imageToText"
	if (/\/images\/(?:generations|edits)(?:\/|$)/.test(path)) return "image"
	if (/\/audio\/speech(?:\/|$)/.test(path)) return "tts"
	if (/\/audio\/(?:transcriptions|translations)(?:\/|$)/.test(path)) return "stt"
	if (/\/audio\/music(?:\/|$)/.test(path)) return "music"
	if (/\/videos?(?:\/|$)/.test(path)) return "video"
	if (/\/search(?:\/|$)/.test(path)) return "webSearch"
	if (/\/web\/(?:fetch|search)(?:\/|$)/.test(path)) return "webFetch"
	if (/\/systemone(?:\/|$)/.test(path)) return "systemone"
	return "other"
}
