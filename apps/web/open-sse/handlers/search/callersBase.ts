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
export function parseDomainFilter(domainFilter?: string[] | null) {
	if (!domainFilter?.length) return { includes: [], excludes: [] }
	const includes = domainFilter.filter((d) => !d.startsWith("-"))
	const excludes = domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1))
	return { includes, excludes }
}

/**
 * Read string setting from providerOptions first, then providerSpecificData.
 * @param {SearchRequestParams} params
 * @param {string} key
 * @returns {string|undefined}
 */
export function getProviderSetting(params, key) {
	const fromOptions = params.providerOptions?.[key]
	if (typeof fromOptions === "string" && fromOptions.trim().length > 0) {
		return fromOptions.trim()
	}
	const fromProviderData = params.providerSpecificData?.[key]
	if (typeof fromProviderData === "string" && fromProviderData.trim().length > 0) {
		return fromProviderData.trim()
	}
	return undefined
}

/**
 * Resolve base URL with optional override from providerOptions.baseUrl.
 *
 * The override is client-controlled and therefore SSRF-hardened: only public
 * http(s) URLs are accepted (internal/private/loopback/metadata addresses are
 * rejected via assertPublicUrl). The provider's own configured baseUrl is
 * trusted as-is (admin-controlled).
 *
 * @param {SearchProviderConfig} config
 * @param {SearchRequestParams} params
 * @returns {string}
 */
export function resolveBaseUrl(config, params) {
	const override = getProviderSetting(params, "baseUrl")
	if (override) {
		// SSRF guard: client-supplied base URLs must be public http(s) only.
		let parsed
		try {
			parsed = new URL(override)
		} catch {
			throw new Error(`Invalid baseUrl: ${override}`)
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`Invalid baseUrl protocol: ${parsed.protocol}`)
		}
		assertPublicUrl(override)
	}
	return (override || config.baseUrl).replace(/\/+$/, "")
}

/**
 * Convert offset+maxResults to 1-indexed page number.
 * @param {number|undefined} offset
 * @param {number} maxResults
 * @returns {number|undefined}
 */
export function toPageNumber(offset, maxResults) {
	if (typeof offset !== "number" || offset <= 0 || maxResults <= 0) return undefined
	return Math.floor(offset / maxResults) + 1
}

// ── Provider Request Builders ───────────────────────────────────────────
