// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.ts"
import type { ProviderMediaConfig } from "../../types.ts"

const imageCfg = (id): ProviderMediaConfig =>
	(PROVIDER_MEDIA[id]?.imageConfig as ProviderMediaConfig | undefined) || {}
const imageUrl = (id) => imageCfg(id).baseUrl

export default function createOpenAIAdapter(providerId) {
	const cfg = imageCfg(providerId)
	return {
		buildUrl: () => imageUrl(providerId),
		buildHeaders: (creds) => {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				...(cfg.headers || {}),
			}
			const key = creds?.apiKey || creds?.accessToken
			if (key) headers["Authorization"] = `Bearer ${key}`
			return headers
		},
		buildBody: (model, body) => {
			const {
				prompt,
				n = 1,
				size = "1024x1024",
				quality,
				style,
				response_format,
				output_format,
			} = body
			const full: Record<string, unknown> = { model, prompt, n, size, output_format }
			if (quality) full.quality = quality
			if (style) full.style = style
			if (response_format) full.response_format = response_format
			for (const field of ["output_format", "watermark", "prompt_extend"]) {
				if (cfg.bodyFields?.includes(field) && body[field] !== undefined) {
					full[field] = body[field]
				}
			}
			// bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
			if (Array.isArray(cfg.bodyFields)) {
				const req: Record<string, unknown> = {}
				for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f]
				return req
			}
			return full
		},
		normalize: (responseBody) => responseBody,
	}
}
