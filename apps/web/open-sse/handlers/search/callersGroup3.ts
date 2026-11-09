/**
 * Search Provider Request Builders
 *
 * Builds HTTP request `{ url, init }` for 10 search providers.
 *
 * @typedef {Object} SearchProviderConfig
 * @property {string} id
 * @property {string} baseUrl
 * @property {string} [method]
 *
 * @typedef {Object} ContentOptions
 * @property {boolean} [snippet]
 * @property {boolean} [full_page]
 * @property {string}  [format]
 * @property {number}  [max_characters]
 *
 * @typedef {Object} SearchRequestParams
 * @property {string}   query
 * @property {string}   searchType
 * @property {number}   maxResults
 * @property {string}   [token]
 * @property {string}   [country]
 * @property {string}   [language]
 * @property {string}   [timeRange]
 * @property {number}   [offset]
 * @property {string[]} [domainFilter]
 * @property {ContentOptions}        [contentOptions]
 * @property {Record<string,unknown>} [providerOptions]
 * @property {Record<string,unknown>} [providerSpecificData]
 */

import { assertPublicUrl } from "../../../src/shared/utils/ssrfGuard.ts"

/** Provider entry `buildSearchRequest` dispatches on. */
export interface SearchProviderConfig {
	id: string
	baseUrl?: string
	method?: string
	[key: string]: unknown
}

/** Per-hit content options (snippet / full page extraction). */
export interface ContentOptions {
	snippet?: boolean
	full_page?: boolean
	format?: string
	max_characters?: number
}

/** Normalized search request handed to every provider builder. */
export interface SearchRequestParams {
	query: string
	searchType: string
	maxResults: number
	token?: string
	country?: string
	language?: string
	timeRange?: string
	offset?: number
	domainFilter?: string[]
	contentOptions?: ContentOptions
	providerOptions?: Record<string, unknown>
	providerSpecificData?: Record<string, unknown>
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Split domain filter into includes / excludes (excludes prefixed with "-").
 * @param {string[]} [domainFilter]
 * @returns {{includes: string[], excludes: string[]}}
 */
import {
	getProviderSetting,
	parseDomainFilter,
	resolveBaseUrl,
	toPageNumber,
} from "./callersBase.ts"
import {
	buildBraveRequest,
	buildExaRequest,
	buildPerplexityRequest,
	buildSerperRequest,
} from "./callersGroup1.ts"
import {
	buildGooglePseRequest,
	buildLinkupRequest,
	buildSearchApiRequest,
	buildTavilyRequest,
} from "./callersGroup2.ts"
export function buildYouComRequest(config, params) {
	const apiKey = params.token
	if (!apiKey) throw new Error("You.com Search requires an API key")

	const { includes, excludes } = parseDomainFilter(params.domainFilter)
	const qp = new URLSearchParams({
		query: params.query,
		count: String(Math.min(params.maxResults, 100)),
	})

	if (params.timeRange && params.timeRange !== "any") qp.set("freshness", params.timeRange)
	if (typeof params.offset === "number" && params.offset > 0 && params.maxResults > 0) {
		qp.set("offset", String(Math.min(Math.floor(params.offset / params.maxResults), 9)))
	}
	if (params.country) qp.set("country", params.country)
	if (params.language) qp.set("language", params.language)
	if (includes.length) qp.set("include_domains", includes.join(","))
	if (excludes.length) qp.set("exclude_domains", excludes.join(","))

	if (params.contentOptions?.full_page) {
		qp.set("livecrawl", params.searchType === "news" ? "news" : "web")
		qp.append("livecrawl_formats", params.contentOptions.format === "markdown" ? "markdown" : "html")
	}

	return {
		url: `${resolveBaseUrl(config, params)}?${qp}`,
		init: {
			method: "GET",
			headers: { Accept: "application/json", "X-API-Key": apiKey },
		},
	}
}

export function buildSearxngRequest(config, params) {
	const baseUrl = resolveBaseUrl(config, params)
	const url = baseUrl.endsWith("/search") ? baseUrl : `${baseUrl}/search`
	const qp = new URLSearchParams({
		q: params.query,
		format: "json",
		categories: params.searchType === "news" ? "news" : "general",
	})
	if (params.language) qp.set("language", params.language)
	if (params.timeRange && params.timeRange !== "any") qp.set("time_range", params.timeRange)

	const page = toPageNumber(params.offset, params.maxResults)
	if (page) qp.set("pageno", String(page))

	return {
		url: `${url}?${qp}`,
		init: {
			method: "GET",
			headers: { Accept: "application/json" },
		},
	}
}

export function buildXquikRequest(config, params) {
	const apiKey = params.token
	if (!apiKey) throw new Error("Xquik requires an API key")

	const queryType = getProviderSetting(params, "queryType")
	if (queryType && !["Latest", "Top"].includes(queryType)) {
		throw new Error("Xquik queryType must be Latest or Top")
	}

	const qp = new URLSearchParams({
		q: params.query,
		limit: String(params.maxResults),
	})
	const cursor = getProviderSetting(params, "cursor")
	if (cursor) qp.set("cursor", cursor)
	if (queryType) qp.set("queryType", queryType)
	if (params.language) qp.set("language", params.language)

	return {
		url: `${resolveBaseUrl(config, params)}?${qp}`,
		init: {
			method: "GET",
			headers: { Accept: "application/json", "x-api-key": apiKey },
		},
	}
}

export function buildTinyfishRequest(config, params) {
	if (params.searchType && !["web", "news", "research_paper"].includes(params.searchType)) {
		throw new Error("Unsupported TinyFish search type")
	}
	const qp = new URLSearchParams({ query: params.query })
	if (params.searchType && params.searchType !== "web") qp.set("domain_type", params.searchType)
	if (params.country) qp.set("location", params.country)
	if (params.language) qp.set("language", params.language)
	const { includes, excludes } = parseDomainFilter(params.domainFilter)
	if (includes.length) qp.set("include_domains", includes.join(","))
	if (excludes.length) qp.set("exclude_domains", excludes.join(","))
	if (Number.isInteger(params.offset) && params.offset > 0) {
		if (params.offset >= 110) throw new Error("TinyFish search offset exceeds available pages")
		if ((params.offset % 10) + params.maxResults > 10)
			throw new Error("TinyFish search offset and max_results must fit within one page")
		qp.set("page", String(Math.floor(params.offset / 10)))
	}
	return {
		// Keep API-key endpoint fixed; client baseUrl overrides must not receive the key.
		url: `${config.baseUrl}?${qp}`,
		init: { method: "GET", headers: { Accept: "application/json", "X-API-Key": params.token } },
	}
}

// ── Ollama Cloud web_search ──────────────────────────────────────────────
// POST https://ollama.com/api/web_search { query, max_results }
// Response: { results: [{ title, url, content, published_at? }] }
export function buildOllamaSearchRequest(config, params) {
	const body: Record<string, unknown> = { query: params.query, max_results: params.maxResults }
	if (params.country) body.country = params.country
	if (params.language) body.language = params.language
	return {
		url: resolveBaseUrl(config, params),
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
			},
			body: JSON.stringify(body),
		},
	}
}

// ── GLM Coding plan MCP web_search_prime ──────────────────────────────────
// POST https://api.z.ai/api/mcp/web_search_prime/mcp
// JSON-RPC envelope: { jsonrpc, id, method: "tools/call",
//   params: { name: "web_search_prime", arguments: { search_query, count } } }
// Response: { result: { content: [{ type: "text", text: "<json>" }] } }
export function buildGlmSearchRequest(config, params) {
	const body = {
		jsonrpc: "2.0",
		id: `9r-${Date.now()}`,
		method: "tools/call",
		params: {
			name: "web_search_prime",
			arguments: { search_query: params.query, count: params.maxResults },
		},
	}
	return {
		url: resolveBaseUrl(config, params),
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
			},
			body: JSON.stringify(body),
		},
	}
}

// ── Dispatcher ──────────────────────────────────────────────────────────

export const BUILDERS = {
	serper: buildSerperRequest,
	"brave-search": buildBraveRequest,
	perplexity: buildPerplexityRequest,
	exa: buildExaRequest,
	tavily: buildTavilyRequest,
	"google-pse": buildGooglePseRequest,
	linkup: buildLinkupRequest,
	searchapi: buildSearchApiRequest,
	youcom: buildYouComRequest,
	searxng: buildSearxngRequest,
	xquik: buildXquikRequest,
	tinyfish: buildTinyfishRequest,
	"ollama-search": buildOllamaSearchRequest,
	glm: buildGlmSearchRequest,
}

/**
 * Dispatch to the correct provider builder by `provider.id`.
 * Falls back to generic POST + bearer auth for unknown providers.
 * @param {SearchProviderConfig} provider
 * @param {SearchRequestParams} params
 * @returns {{url: string, init: RequestInit}}
 */
