// Embeddings provider adapter registry

import gemini from "./gemini.ts"
import github from "./github.ts"
import ollamaLocal from "./ollamaLocal.ts"
import createOpenAIEmbeddingAdapter from "./openai.ts"
import openaiCompatNode from "./openaiCompatNode.ts"
import selfhostedEmbedding from "./selfhostedEmbedding.ts"

const OPENAI_COMPAT_PROVIDERS = [
	"openai",
	"openrouter",
	"mistral",
	"voyage-ai",
	"fireworks",
	"together",
	"nebius",
	"nvidia",
	"jina-ai",
	"vercel-ai-gateway",
]

const ADAPTERS = {
	...Object.fromEntries(OPENAI_COMPAT_PROVIDERS.map((id) => [id, createOpenAIEmbeddingAdapter(id)])),
	gemini,
	google_ai_studio: gemini,
	github,
	// Self-hosted reads creds.providerSpecificData.baseUrl (one provider, many
	// servers) - but via its OWN adapter, not openaiCompatNode: that one falls back
	// to api.openai.com when no baseUrl is set, which under a provider called
	// "Self-hosted Embedding" means silently shipping the input and API key to
	// OpenAI. selfhostedEmbedding refuses instead.
	"selfhosted-embedding": selfhostedEmbedding,
	"ollama-local": ollamaLocal,
}

export function getEmbeddingAdapter(provider) {
	if (ADAPTERS[provider]) return ADAPTERS[provider]
	if (provider?.startsWith?.("openai-compatible-") || provider?.startsWith?.("custom-embedding-")) {
		return openaiCompatNode
	}
	return null
}
