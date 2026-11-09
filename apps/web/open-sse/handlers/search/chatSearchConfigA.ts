/**
 * Wrap chat-completions endpoints (with built-in web search) into the unified
 * /v1/search response format. Supports gemini, antigravity, openai, xai, kimi,
 * minimax, perplexity.
 */
import { PROVIDER_MEDIA } from "../../providers/index.ts"
import { ANTIGRAVITY_IDE_USER_AGENT } from "../../providers/shared.ts"

// Default search model + endpoint derive from registry searchViaChat (single source)
const searchModel = (id) => PROVIDER_MEDIA[id]?.searchViaChat?.defaultModel as string | undefined
const searchEndpoint = (id, model?) =>
	String(PROVIDER_MEDIA[id]?.searchViaChat?.endpoint || "").replace("{model}", model || "")

const REQUEST_TIMEOUT_MS = 15000
const DEFAULT_MAX_RESULTS = 10

/**
 * Normalize a citation entry into the unified result shape.
 * @param {{url:string, title?:string, snippet?:string}} c
 * @param {number} index
 * @param {string} provider
 * @param {string} retrievedAt
 */
// Antigravity search request envelope (mirrors the IDE client)
const AG_CLIENT_NAME = "antigravity"
const AG_SEARCH_GENERATION_CONFIG = { temperature: 1.0, maxOutputTokens: 8192 }
const AG_CONTEXT_BEFORE = 150
const AG_CONTEXT_AFTER = 250

import { expandSegment, joinPieces, normalizeCitation } from "./chatSearchHelpers.ts"

export const CHAT_SEARCH_CONFIG_A: Record<string, any> = {
	gemini: {
		endpoint: (model) => searchEndpoint("gemini", model),
		buildBody: (query) => ({
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			"x-goog-api-key": token,
		}),
		extractAnswer: (data) => {
			const candidate = data?.candidates?.[0]
			const parts = candidate?.content?.parts || []
			const text = parts
				.map((p) => p?.text || "")
				.filter(Boolean)
				.join("")
			const chunks = candidate?.groundingMetadata?.groundingChunks || []
			const citations = chunks
				.map((ch) => ch?.web)
				.filter(Boolean)
				.map((w) => ({ url: w.uri || w.url, title: w.title || "" }))
				.filter((c) => c.url)
			const tokens = data?.usageMetadata?.totalTokenCount || 0
			return { text, citations, tokens }
		},
	},

	antigravity: {
		endpoint: () => searchEndpoint("antigravity"),
		// Upstream 403s on a missing or fabricated project - surface the real cause
		requireCredentials: (credentials) =>
			credentials?.projectId ? null : "Antigravity account has no projectId - reconnect the account",
		buildBody: (query, model, credentials) => ({
			project: credentials.projectId,
			model,
			userAgent: AG_CLIENT_NAME,
			requestType: "search",
			request: {
				contents: [{ role: "user", parts: [{ text: query }] }],
				tools: [{ googleSearch: {} }],
				generationConfig: AG_SEARCH_GENERATION_CONFIG,
			},
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
		}),
		extractAnswer: (data) => {
			// Antigravity wraps the Gemini payload in { response: {...} }
			const response = data?.response || data
			const candidate = response?.candidates?.[0]
			const parts = candidate?.content?.parts || []
			const text = parts
				.map((p) => p?.text || "")
				.filter(Boolean)
				.join("")
			const grounding = candidate?.groundingMetadata || {}
			const chunks = grounding.groundingChunks || []
			const supports = grounding.groundingSupports || []

			// Upstream repeats the same source across chunks - key by URL so it stays one citation.
			// Map, not a plain object: both the index and the URL come from upstream.
			const sources = new Map()
			const byIndex = chunks.map((ch) => {
				const web = ch?.web
				const url = web?.uri || web?.url || ""
				if (!url) return null
				if (!sources.has(url))
					sources.set(url, { title: web.title || "", snippets: new Set(), contexts: new Set() })
				return sources.get(url)
			})

			// Each support ties a sentence of the answer back to the chunks that grounded it
			for (const s of supports) {
				const segment = s?.segment
				const grounded = segment?.text || ""
				const expanded = expandSegment(text, segment) || grounded
				for (const idx of s?.groundingChunkIndices || []) {
					const source = Number.isInteger(idx) ? byIndex[idx] : null
					if (!source) continue
					if (grounded) source.snippets.add(grounded)
					if (expanded) source.contexts.add(expanded)
				}
			}

			const citations = [...sources].map(([url, src]) => {
				const snippet = joinPieces(src.snippets, " | ") || src.title
				return { url, title: src.title, snippet, content: joinPieces(src.contexts, "\n\n") || snippet }
			})

			const tokens = response?.usageMetadata?.totalTokenCount || 0
			return { text, citations, tokens }
		},
	},

	openai: {
		endpoint: () => searchEndpoint("openai"),
		buildBody: (query, model) => {
			const body: {
				model?: string
				messages: Array<{ role: string; content: string }>
				tools?: Array<Record<string, unknown>>
			} = {
				model,
				messages: [{ role: "user", content: query }],
			}
			// Non-search-preview models need explicit web_search tool
			if (!/search/i.test(model)) {
				body.tools = [{ type: "web_search" }]
			}
			return body
		},
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		}),
		extractAnswer: (data) => {
			const msg = data?.choices?.[0]?.message || {}
			const text = msg.content || ""
			const annotations = Array.isArray(msg.annotations) ? msg.annotations : []
			const fromAnn = annotations
				.map((a) => a?.url_citation)
				.filter(Boolean)
				.map((u) => ({ url: u.url, title: u.title || "" }))
			const fromTop = Array.isArray(data?.citations)
				? data.citations.map(normalizeCitation).filter(Boolean)
				: []
			const citations = fromAnn.length ? fromAnn : fromTop
			const tokens = data?.usage?.total_tokens || 0
			return { text, citations, tokens }
		},
	},
}
