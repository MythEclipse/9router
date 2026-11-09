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
export function buildSerperRequest(config, params) {
	const endpoint = params.searchType === "news" ? "/news" : "/search"
	const body: Record<string, unknown> = { q: params.query, num: params.maxResults }
	if (params.country) body.gl = params.country.toLowerCase()
	if (params.language) body.hl = params.language
	return {
		url: `${resolveBaseUrl(config, params)}${endpoint}`,
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-API-Key": params.token },
			body: JSON.stringify(body),
		},
	}
}

export function buildBraveRequest(config, params) {
	const endpoint = params.searchType === "news" ? "/news/search" : "/web/search"
	const qp = new URLSearchParams({ q: params.query, count: String(params.maxResults) })
	if (params.country) qp.set("country", params.country)
	if (params.language) qp.set("search_lang", params.language)
	return {
		url: `${resolveBaseUrl(config, params)}${endpoint}?${qp}`,
		init: {
			method: "GET",
			headers: { Accept: "application/json", "X-Subscription-Token": params.token },
		},
	}
}

export function buildPerplexityRequest(config, params) {
	const body: Record<string, unknown> = { query: params.query, max_results: params.maxResults }
	if (params.country) body.country = params.country
	if (params.language) body.search_language_filter = [params.language]
	if (params.domainFilter?.length) body.search_domain_filter = params.domainFilter
	return {
		url: resolveBaseUrl(config, params),
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.token}` },
			body: JSON.stringify(body),
		},
	}
}

export function buildExaRequest(config, params) {
	const { includes, excludes } = parseDomainFilter(params.domainFilter)
	// Exa moved the content options under a `contents` object; the top-level
	// `text` / `highlights` booleans are still accepted but silently ignored, so
	// every hit came back with an empty snippet.
	const body: Record<string, unknown> = {
		query: params.query,
		numResults: params.maxResults,
		type: "auto",
		contents: { text: true, highlights: true },
	}
	if (includes.length) body.includeDomains = includes
	if (excludes.length) body.excludeDomains = excludes
	if (params.searchType === "news") body.category = "news"
	return {
		url: resolveBaseUrl(config, params),
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": params.token },
			body: JSON.stringify(body),
		},
	}
}
