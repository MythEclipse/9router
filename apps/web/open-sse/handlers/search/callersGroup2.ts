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
export function buildTavilyRequest(config, params) {
	const { includes, excludes } = parseDomainFilter(params.domainFilter)
	const body: Record<string, unknown> = {
		query: params.query,
		max_results: params.maxResults,
		topic: params.searchType === "news" ? "news" : "general",
	}
	if (includes.length) body.include_domains = includes
	if (excludes.length) body.exclude_domains = excludes
	if (params.country) body.country = params.country
	return {
		url: resolveBaseUrl(config, params),
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.token}` },
			body: JSON.stringify(body),
		},
	}
}

export function buildGooglePseRequest(config, params) {
	const apiKey = params.token
	const cx = getProviderSetting(params, "cx")
	if (!apiKey || !cx) {
		throw new Error("Google Programmable Search requires both apiKey and cx")
	}
	const qp = new URLSearchParams({
		key: apiKey,
		cx,
		q: params.query,
		num: String(Math.min(params.maxResults, 10)),
	})
	if (params.country) qp.set("gl", params.country.toLowerCase())
	if (params.language) qp.set("hl", params.language)
	if (params.timeRange && params.timeRange !== "any") {
		const dateRestrictMap = { day: "d1", week: "w1", month: "m1", year: "y1" }
		const dateRestrict = dateRestrictMap[params.timeRange]
		if (dateRestrict) qp.set("dateRestrict", dateRestrict)
	}
	if (typeof params.offset === "number" && params.offset > 0) {
		qp.set("start", String(Math.min(params.offset + 1, 91)))
	}
	return {
		url: `${resolveBaseUrl(config, params)}?${qp}`,
		init: {
			method: "GET",
			headers: { Accept: "application/json" },
		},
	}
}

export function buildLinkupRequest(config, params) {
	const apiKey = params.token
	if (!apiKey) throw new Error("Linkup Search requires an API key")

	const { includes, excludes } = parseDomainFilter(params.domainFilter)
	const requestedDepth = getProviderSetting(params, "depth")
	const depth =
		requestedDepth && ["fast", "standard", "deep"].includes(requestedDepth)
			? requestedDepth
			: "standard"

	const body: Record<string, unknown> = {
		q: params.query,
		depth,
		outputType: "searchResults",
		maxResults: params.maxResults,
	}
	if (includes.length) body.includeDomains = includes
	if (excludes.length) body.excludeDomains = excludes
	if (params.timeRange && params.timeRange !== "any") {
		const today = new Date()
		const toDate = today.toISOString().slice(0, 10)
		const from = new Date(today)
		if (params.timeRange === "day") from.setUTCDate(from.getUTCDate() - 1)
		if (params.timeRange === "week") from.setUTCDate(from.getUTCDate() - 7)
		if (params.timeRange === "month") from.setUTCMonth(from.getUTCMonth() - 1)
		if (params.timeRange === "year") from.setUTCFullYear(from.getUTCFullYear() - 1)
		body.fromDate = from.toISOString().slice(0, 10)
		body.toDate = toDate
	}

	return {
		url: resolveBaseUrl(config, params),
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
		},
	}
}

export function buildSearchApiRequest(config, params) {
	const apiKey = params.token
	if (!apiKey) throw new Error("SearchAPI requires an API key")

	const qp = new URLSearchParams({
		engine: params.searchType === "news" ? "google_news" : "google",
		q: params.query,
		api_key: apiKey,
	})
	if (params.country) qp.set("gl", params.country.toLowerCase())
	if (params.language) qp.set("hl", params.language)

	const page = toPageNumber(params.offset, params.maxResults)
	if (page) qp.set("page", String(page))

	return {
		url: `${resolveBaseUrl(config, params)}?${qp}`,
		init: {
			method: "GET",
			headers: { Accept: "application/json" },
		},
	}
}
