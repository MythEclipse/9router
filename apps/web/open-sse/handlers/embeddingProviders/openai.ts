// OpenAI-compatible embeddings adapter (most providers)

import { PROVIDER_MEDIA } from "../../providers/index.ts"
import { bearerAuth } from "./_base.ts"

// media-only providers without a registry file keep URL here; rest derive from registry media.embeddingConfig.baseUrl
const ENDPOINTS = {
	"jina-ai": "https://api.jina.ai/v1/embeddings",
}

const embedCfg = (id) =>
	PROVIDER_MEDIA[id]?.embeddingConfig || ({} as (typeof PROVIDER_MEDIA)[string]["embeddingConfig"])
const embedUrl = (id) => embedCfg(id).baseUrl || ENDPOINTS[id]

export default function createOpenAIEmbeddingAdapter(providerId) {
	const cfg = embedCfg(providerId)
	return {
		buildUrl: () => embedUrl(providerId),
		buildHeaders: (creds) => {
			return {
				"Content-Type": "application/json",
				...bearerAuth(creds),
				...((cfg.headers || {}) as Record<string, string>),
			}
		},
		buildBody: (
			model,
			{
				input,
				encoding_format,
				dimensions,
			}: { input?: unknown; encoding_format?: string; dimensions?: number | string },
		) => {
			const body: { model: string; input: unknown; encoding_format?: string; dimensions?: number } = {
				model,
				input: typeof input === "string" ? [input] : input,
			}
			if (encoding_format) body.encoding_format = encoding_format
			if (dimensions != null && dimensions !== "") {
				const dim = Number(dimensions)
				if (Number.isFinite(dim) && dim > 0) body.dimensions = dim
			}
			return body
		},
		normalize: (responseBody) => responseBody,
	}
}
