/**
 * Recent-request row mapping.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { parseJson } from "../helpers/jsonCol.ts"
import { labelForRow } from "../helpers/modelLabel.ts"

import type { RecentRequest, UsageTokens } from "./usageTypes.ts"

interface RecentRowShape {
	timestamp?: unknown
	provider?: unknown
	model?: unknown
	tokens?: unknown
	status?: unknown
	meta?: unknown
}

/**
 * Map usageHistory rows onto the dashboard's recent-request list.
 *
 * Two rules live here and are easy to lose: the `meta` blob must be read so a combo
 * is reported by the model that actually served it (not the alias the caller asked
 * for), and only billed rows count — pending/error lifecycle rows belong to the
 * request log and would otherwise inflate the totals.
 */
export function mapRecentRequests(
	rows: RecentRowShape[],
	options: { limit?: number; isModelAllowed?: (model: string) => boolean } = {},
): RecentRequest[] {
	const { limit = 20, isModelAllowed } = options
	return rows
		.map((r): RecentRequest => {
			const t = parseJson<UsageTokens>((r.tokens as string | null) ?? null, {}) || {}
			const label = labelForRow(r.model, r.meta)
			return {
				timestamp: String(r.timestamp),
				model: label.display,
				requestedModel: label.alias,
				provider: (r.provider as string) || "",
				promptTokens: t.prompt_tokens || t.input_tokens || 0,
				completionTokens: t.completion_tokens || t.output_tokens || 0,
				cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
				status: (r.status as string) || "ok",
			}
		})
		.filter((e) => {
			if (e.status !== "ok") return false
			if (isModelAllowed && !isModelAllowed(e.model)) return false
			if (e.promptTokens === 0 && e.completionTokens === 0) return false
			return true
		})
		.slice(0, limit)
}

/**
 * Add one usageHistory row to every bucket of the report.
 *
 * The filter-by-api-key branch and the 24h/today branch each had their own copy of
 * this, byte for byte identical apart from how they handled a row with no key. One
 * function covers both: `includeUnkeyedRows` decides whether a keyless row lands in a
 * "local-no-key" bucket (the live view, where local traffic is real) or is skipped
 * (a single key's own report, where it is not that key's traffic).
 *
 * `buckets` is the report being built — passed in rather than returned because the
 * daily-rollup path also writes to it and the caller already holds the reference.
 */
/**
 * Add one row's numbers to the report's flat total fields.
 *
 * The response shape keeps `totalPromptTokens` &c. at the top level, so this writes
 * them directly rather than through a nested object that would have to be flattened
 * again — the wire shape is the report's contract and a refactor must not move it.
 */
