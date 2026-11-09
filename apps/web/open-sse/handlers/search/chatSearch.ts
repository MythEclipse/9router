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

import { CHAT_SEARCH_CONFIG_A } from "./chatSearchConfigA.ts"
import { CHAT_SEARCH_CONFIG_B } from "./chatSearchConfigB.ts"
/**
 * Normalize a citation entry into the unified result shape.
 * @param {{url:string, title?:string, snippet?:string}} c
 * @param {number} index
 * @param {string} provider
 * @param {string} retrievedAt
 */
import { expandSegment, joinPieces, normalizeCitation, toResult } from "./chatSearchHelpers.ts"

const CHAT_SEARCH_CONFIG = { ...CHAT_SEARCH_CONFIG_A, ...CHAT_SEARCH_CONFIG_B }
export async function handleChatSearch({ provider, query, maxResults, model, credentials, log }) {
	const startTime = Date.now()
	const cfg = CHAT_SEARCH_CONFIG[provider]

	if (!cfg) {
		return {
			success: false,
			status: 400,
			error: `Unsupported chat-search provider: ${provider}`,
		}
	}

	if (!query || typeof query !== "string") {
		return { success: false, status: 400, error: "Missing query" }
	}

	const token = credentials?.apiKey || credentials?.accessToken
	if (!token) {
		return {
			success: false,
			status: 401,
			error: "Missing credentials (apiKey or accessToken)",
		}
	}

	const credentialError = cfg.requireCredentials?.(credentials)
	if (credentialError) {
		return { success: false, status: 401, error: credentialError }
	}

	const limit =
		Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : DEFAULT_MAX_RESULTS
	const useModel = model || searchModel(provider)
	const url = cfg.endpoint(useModel)
	const body = cfg.buildBody(query, useModel, credentials)
	const headers = cfg.buildHeaders(token)

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

	const upstreamStart = Date.now()
	let resp
	try {
		resp = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		})
	} catch (err) {
		clearTimeout(timer)
		if (err?.name === "AbortError") {
			log?.warn?.(`[chatSearch] timeout provider=${provider}`)
			return { success: false, status: 504, error: "Upstream timeout" }
		}
		log?.error?.(`[chatSearch] network error provider=${provider}: ${err?.message}`)
		return {
			success: false,
			status: 502,
			error: `Network error: ${err?.message || "unknown"}`,
		}
	}
	clearTimeout(timer)
	const upstreamLatency = Date.now() - upstreamStart

	let data
	try {
		data = await resp.json()
	} catch {
		return {
			success: false,
			status: 502,
			error: `Invalid upstream response (status ${resp.status})`,
		}
	}

	if (!resp.ok) {
		const errMsg =
			data?.error?.message || data?.error || data?.message || `Upstream HTTP ${resp.status}`
		log?.warn?.(`[chatSearch] upstream error provider=${provider} status=${resp.status}`)
		return {
			success: false,
			status: resp.status,
			error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
		}
	}

	const { text, citations, tokens } = cfg.extractAnswer(data)
	const retrievedAt = new Date().toISOString()
	const limited = (citations || []).slice(0, limit)
	const results = limited.map((c, i) => toResult(c, i, provider, retrievedAt))

	return {
		success: true,
		status: 200,
		data: {
			provider,
			query,
			results,
			answer: { source: provider, text: text || "", model: useModel },
			usage: { queries_used: 1, search_cost_usd: 0, llm_tokens: tokens || 0 },
			metrics: {
				response_time_ms: Date.now() - startTime,
				upstream_latency_ms: upstreamLatency,
				total_results_available: null,
			},
			errors: [],
		},
	}
}

export { CHAT_SEARCH_CONFIG }
