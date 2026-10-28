export const API_KEY_ENDPOINT_KINDS = [
	"chat",
	"responses",
	"models",
	"embeddings",
	"images",
	"audio",
	"search",
	"web",
	"videos",
	"systemone",
	"other",
] as const

export type ApiKeyEndpointKind = (typeof API_KEY_ENDPOINT_KINDS)[number]

export function normalizeAllowedEndpoints(value: unknown): ApiKeyEndpointKind[] {
	let parsed = value
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed)
		} catch {
			return []
		}
	}
	if (!Array.isArray(parsed)) return []
	return [
		...new Set(
			parsed.filter(
				(kind): kind is ApiKeyEndpointKind =>
					typeof kind === "string" && API_KEY_ENDPOINT_KINDS.includes(kind as ApiKeyEndpointKind),
			),
		),
	]
}

export function classifyApiKeyEndpoint(pathname: string): ApiKeyEndpointKind {
	const path = pathname
		.replace(/^\/api(?=\/v1(?:beta)?(?:\/|$))/, "")
		.replace(/^\/v1\/v1(?=\/|$)/, "/v1")
	if (/^\/(?:responses|codex)(?:\/|$)/.test(path)) return "responses"
	if (/^\/systemone(?:\/|$)/.test(path)) return "systemone"
	if (/^\/v1(?:beta)?\/(?:chat\/completions|messages(?:\/|$)|api\/chat)(?:\/|$)/.test(path))
		return "chat"
	if (/^\/v1\/responses(?:\/|$)/.test(path)) return "responses"
	if (/^\/v1(?:beta)?\/models(?:\/|$)/.test(path)) return "models"
	if (/^\/v1\/embeddings(?:\/|$)/.test(path)) return "embeddings"
	if (/^\/v1\/images(?:\/|$)/.test(path)) return "images"
	if (/^\/v1\/audio(?:\/|$)/.test(path)) return "audio"
	if (/^\/v1\/search(?:\/|$)/.test(path)) return "search"
	if (/^\/v1\/web(?:\/|$)/.test(path)) return "web"
	if (/^\/v1\/videos(?:\/|$)/.test(path)) return "videos"
	if (/^\/v1\/systemone(?:\/|$)/.test(path)) return "systemone"
	return "other"
}

export function isApiKeyEndpointAllowed(
	allowedEndpoints: readonly string[] | null | undefined,
	kind: ApiKeyEndpointKind,
): boolean {
	return !allowedEndpoints?.length || allowedEndpoints.includes(kind)
}

export function clampAllowedEndpoints(
	requested: unknown,
	parentAllowed: readonly string[] | null | undefined,
): ApiKeyEndpointKind[] {
	const parent = normalizeAllowedEndpoints(parentAllowed)
	const requestedList = normalizeAllowedEndpoints(requested)
	if (!parent.length) return requestedList
	if (!requestedList.length) return parent
	const intersection = requestedList.filter((kind) => parent.includes(kind))
	return intersection.length ? intersection : parent
}
