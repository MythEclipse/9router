/** Validate credential: config-driven probes. */

import type {
	AiProviderEntry,
	ProbeConfig,
	ProbeRequest,
	ValidationResult,
} from "./validate-credential-types.ts"
import {
	bearer,
	json,
	mediaProbeVerdict,
	refusalMessage,
	webProbeVerdict,
} from "./validate-credential-types.ts"

/** The host wiring for config-driven probes. */
export interface ProbeConfigHost {
	readonly send: (
		request: ProbeRequest,
	) => Promise<{ readonly status: number; readonly ok: boolean; readonly text?: string }>
	readonly aiProvider: (provider: string) => AiProviderEntry | undefined
	readonly defaultModel: (provider: string) => string
	/** The provider has a plan of its own, which decides when its config cannot probe. */
	readonly ownPlan?: boolean
}

/**
 * Probe a web or media provider through its own config block.
 *
 * Returns null when the provider is not that kind, so the caller falls through:
 * a provider that serves both chat and search is validated on the chat lane,
 * which is the lane its key is actually used on.
 */
export async function probeConfigDriven(
	host: ProbeConfigHost,
	provider: string,
	apiKey: string,
	kind: "web" | "media",
): Promise<ValidationResult | null> {
	const { send, aiProvider } = host
	const ai = aiProvider(provider)
	if (!ai) return null
	const kinds = ai.serviceKinds ?? ["llm"]
	const mediaKinds = new Set(["tts", "embedding", "stt", "image", "video", "music", "imageToText"])

	if (kind === "web") {
		const isWebOnly = kinds.every((k) => k === "webSearch" || k === "webFetch")
		if (!isWebOnly) return null
		const cfg = ai.searchConfig ?? ai.fetchConfig
		if (!cfg) return null
		if (cfg.authType === "none") return { valid: true, error: null }
		const request = authRequest(host, provider, cfg, apiKey, "web")
		if (!request) return { valid: true, error: null }
		const response = await send(request)
		const valid = webProbeVerdict(response.status)
		return { valid, error: valid ? null : refusalMessage(provider) }
	}

	const isMediaOnly = kinds.every((k) => mediaKinds.has(k))
	if (!isMediaOnly) return null
	const cfg =
		ai.ttsConfig ??
		ai.sttConfig ??
		ai.embeddingConfig ??
		ai.imageConfig ??
		ai.videoConfig ??
		ai.musicConfig
	// No probe config: accept best-effort and let the first real call decide.
	if (!cfg) return { valid: true, error: null }
	if (ai.noAuth || cfg.authType === "none") return { valid: true, error: null }
	const request = authRequest(host, provider, cfg, apiKey, "media")
	// A scheme needing data this endpoint does not carry cannot be probed; saying
	// so beats falling through to "not supported", which reads as a dashboard bug.
	// The exception is a provider with a plan of its own (Fal's model catalogue):
	// the best-effort "valid" here never looks at the key, so it would report a
	// wrong one as fine and the plan would never run.
	if (!request) return host.ownPlan ? null : { valid: true, error: null }
	const response = await send(request)
	const valid = mediaProbeVerdict(response.status)
	return { valid, error: valid ? null : refusalMessage(provider) }
}

/**
 * The request a config block describes.
 *
 * The auth schemes that need provider-specific data — PlayHT's two-header form,
 * AWS sigv4 — return null, which the caller reads as "cannot probe": reporting
 * them invalid would refuse a key that is fine.
 */
export function authRequest(
	host: ProbeConfigHost,
	provider: string,
	cfg: ProbeConfig,
	apiKey: string,
	kind: "web" | "media",
): ProbeRequest | null {
	const { defaultModel } = host
	const headers: Record<string, string> = { ...json, ...(cfg.extraHeaders ?? {}) }
	let url = cfg.validateUrl ?? cfg.baseUrl ?? ""
	let body: string | undefined

	if (kind === "web") {
		switch (cfg.authHeader) {
			case "bearer":
				headers.Authorization = `Bearer ${apiKey}`
				break
			case "x-api-key":
				headers["x-api-key"] = apiKey
				break
			case "x-subscription-token":
				headers["x-subscription-token"] = apiKey
				break
			case "key":
				url += `?key=${encodeURIComponent(apiKey)}&q=ping&cx=test`
				break
			case "api_key":
				url += `?api_key=${encodeURIComponent(apiKey)}&q=ping&engine=google`
				break
		}
		if (cfg.method === "POST") {
			body = JSON.stringify({ query: "ping", q: "ping", url: "https://example.com" })
		}
		return { url, method: cfg.method ?? "GET", headers, ...(body ? { body } : {}) }
	}

	if (cfg.authHeader === "playht" || cfg.authHeader === "aws-sigv4") return null
	switch (cfg.authHeader) {
		case "bearer":
			headers.Authorization = `Bearer ${apiKey}`
			break
		case "key":
			headers.Authorization = `Key ${apiKey}`
			break
		case "x-api-key":
			headers["x-api-key"] = apiKey
			break
		case "x-key":
			headers["x-key"] = apiKey
			break
		case "xi-api-key":
			headers["xi-api-key"] = apiKey
			break
		case "token":
			headers.Authorization = `Token ${apiKey}`
			break
		case "basic":
			headers.Authorization = `Basic ${apiKey}`
			break
		default:
			return null
	}
	const method = cfg.method ?? "POST"
	if (method !== "GET") {
		body = JSON.stringify({
			input: "ping",
			text: "ping",
			prompt: "ping",
			model: defaultModel(provider) || "test",
		})
	}
	return { url, method, headers, ...(body ? { body } : {}) }
}
