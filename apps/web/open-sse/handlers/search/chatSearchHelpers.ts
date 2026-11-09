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
export function toResult(c, index, provider, retrievedAt) {
	return {
		title: c.title || "",
		url: c.url,
		snippet: c.snippet || "",
		position: index + 1,
		score: null,
		published_at: null,
		favicon_url: null,
		content: c.content || null,
		metadata: {},
		citation: { provider, retrieved_at: retrievedAt, rank: index + 1 },
		provider_raw: null,
	}
}

// Antigravity search request envelope (mirrors the IDE client)
const AG_CLIENT_NAME = "antigravity"
const AG_SEARCH_GENERATION_CONFIG = { temperature: 1.0, maxOutputTokens: 8192 }
const AG_CONTEXT_BEFORE = 150
const AG_CONTEXT_AFTER = 250

/** Widen a grounded segment to its surrounding sentence(s) in the answer text. */
export function expandSegment(text, segment) {
	const { startIndex, endIndex } = segment || {}
	if (!text || !Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return ""
	const start = Math.max(0, startIndex - AG_CONTEXT_BEFORE)
	const end = Math.min(text.length, endIndex + AG_CONTEXT_AFTER)
	let out = text.slice(start, end).trim()
	// Drop the partial words the window cut off at either edge
	if (start > 0) out = `...${out.replace(/^\S+/, "")}`
	if (end < text.length) out = `${out.replace(/\S+$/, "")}...`
	return out.trim()
}

/** Join deduped grounding pieces, skipping empties. */
export function joinPieces(set, sep) {
	return [...(set || [])].filter(Boolean).join(sep).trim()
}

/** Coerce a citation that might be a raw URL string or an object. */
export function normalizeCitation(c) {
	if (!c) return null
	if (typeof c === "string") return { url: c }
	if (typeof c === "object" && c.url) return c
	return null
}
