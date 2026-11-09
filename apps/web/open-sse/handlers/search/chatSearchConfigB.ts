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

export const CHAT_SEARCH_CONFIG_B: Record<string, any> = {
	xai: {
		endpoint: () => searchEndpoint("xai"),
		buildBody: (query, model) => ({
			model,
			input: [{ role: "user", content: query }],
			tools: [{ type: "web_search" }],
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		}),
		extractAnswer: (data) => {
			// /v1/responses returns output[] array of message/tool blocks
			const output = Array.isArray(data?.output) ? data.output : []
			let text = ""
			const citations = []
			for (const item of output) {
				const parts = Array.isArray(item?.content) ? item.content : []
				for (const p of parts) {
					if (typeof p?.text === "string") text += p.text
					const anns = Array.isArray(p?.annotations) ? p.annotations : []
					for (const a of anns) {
						const c = normalizeCitation(a?.url ? a : a?.url_citation)
						if (c) citations.push(c)
					}
				}
			}
			// Fallback: top-level citations array (some response variants)
			if (!citations.length && Array.isArray(data?.citations)) {
				for (const c of data.citations) {
					const n = normalizeCitation(c)
					if (n) citations.push(n)
				}
			}
			const tokens = data?.usage?.total_tokens || 0
			return { text, citations, tokens }
		},
	},

	kimi: {
		endpoint: () => searchEndpoint("kimi"),
		buildBody: (query, model) => ({
			model,
			messages: [{ role: "user", content: query }],
			tools: [{ type: "builtin_function", function: { name: "$web_search" } }],
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		}),
		extractAnswer: (data) => {
			const msg = data?.choices?.[0]?.message || {}
			const text = msg.content || ""
			const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
			const citations = []
			for (const call of calls) {
				const argStr = call?.function?.arguments
				if (!argStr) continue
				let parsed
				try {
					parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr
				} catch {
					continue
				}
				const items = parsed?.search_results || parsed?.results || parsed?.references || []
				if (Array.isArray(items)) {
					for (const it of items) {
						const url = it?.url || it?.link
						if (!url) continue
						citations.push({
							url,
							title: it.title || "",
							snippet: it.snippet || it.summary || "",
						})
					}
				}
			}
			const tokens = data?.usage?.total_tokens || 0
			return { text, citations, tokens }
		},
	},

	minimax: {
		endpoint: () => searchEndpoint("minimax"),
		buildBody: (query, model) => ({
			model,
			messages: [{ role: "user", content: query }],
			tools: [{ type: "web_search" }],
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		}),
		extractAnswer: (data) => {
			const msg = data?.choices?.[0]?.message || {}
			const text = msg.content || ""
			const citations = []
			const direct = Array.isArray(data?.web_search_results) ? data.web_search_results : []
			for (const it of direct) {
				const url = it?.url || it?.link
				if (url) {
					citations.push({
						url,
						title: it.title || "",
						snippet: it.snippet || it.summary || "",
					})
				}
			}
			if (!citations.length) {
				const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
				for (const call of calls) {
					const argStr = call?.function?.arguments
					if (!argStr) continue
					let parsed
					try {
						parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr
					} catch {
						continue
					}
					const items = parsed?.results || parsed?.search_results || []
					if (Array.isArray(items)) {
						for (const it of items) {
							const url = it?.url || it?.link
							if (!url) continue
							citations.push({
								url,
								title: it.title || "",
								snippet: it.snippet || "",
							})
						}
					}
				}
			}
			const tokens = data?.usage?.total_tokens || 0
			return { text, citations, tokens }
		},
	},

	perplexity: {
		endpoint: () => searchEndpoint("perplexity"),
		buildBody: (query, model) => ({
			model,
			messages: [{ role: "user", content: query }],
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		}),
		extractAnswer: (data) => {
			const msg = data?.choices?.[0]?.message || {}
			const text = msg.content || ""
			const raw = data?.citations || []
			const citations = Array.isArray(raw) ? raw.map(normalizeCitation).filter(Boolean) : []
			const tokens = data?.usage?.total_tokens || 0
			return { text, citations, tokens }
		},
	},

	"perplexity-agent": {
		endpoint: () => searchEndpoint("perplexity-agent"),
		buildBody: (query, model) => ({
			model,
			input: query,
			tools: [{ type: "web_search" }],
		}),
		buildHeaders: (token) => ({
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		}),
		extractAnswer: (data) => {
			const output = Array.isArray(data?.output) ? data.output : []
			let text = ""
			const citations = []
			for (const item of output) {
				const parts = Array.isArray(item?.content) ? item.content : []
				for (const p of parts) {
					if (typeof p?.text === "string") text += p.text
					const anns = Array.isArray(p?.annotations) ? p.annotations : []
					for (const a of anns) {
						const c = normalizeCitation(a?.url ? a : a?.url_citation)
						if (c) citations.push(c)
					}
				}
				const results = Array.isArray(item?.results) ? item.results : []
				for (const r of results) {
					const url = r?.url || r?.link
					if (!url) continue
					citations.push({
						url,
						title: r?.title || "",
						snippet: r?.snippet || "",
					})
				}
			}
			if (!citations.length && Array.isArray(data?.citations)) {
				for (const c of data.citations) {
					const n = normalizeCitation(c)
					if (n) citations.push(n)
				}
			}
			const tokens = data?.usage?.total_tokens || 0
			return { text, citations, tokens }
		},
	},
}
