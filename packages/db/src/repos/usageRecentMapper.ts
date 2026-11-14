/**
 * Recent-request row mapping.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { parseJson } from "../helpers/jsonCol.ts"
import { labelForRow } from "../helpers/modelLabel.ts"
import { serviceKindOf } from "../helpers/serviceKind.ts"

import type { RecentRequest, UsageTokens } from "./usageTypes.ts"

interface RecentRowShape {
	timestamp?: unknown
	provider?: unknown
	model?: unknown
	tokens?: unknown
	status?: unknown
	meta?: unknown
	endpoint?: unknown
}

/**
 * The statuses a billed row can carry.
 *
 * Chat writes `ok` (or the failing HTTP status), while the media handlers write
 * `success`. Both mean "the request completed and was billed"; the stream must not
 * lose a whole lane over a spelling, which is exactly what happened to the
 * embedding and System One rows.
 */
const BILLED_STATUSES = new Set(["ok", "success"])

/**
 * Map usageHistory rows onto the dashboard's recent-request list.
 *
 * Three rules live here and are easy to lose: the `meta` blob must be read so a combo
 * is reported by the model that actually served it (not the alias the caller asked
 * for), only billed rows count — pending/error lifecycle rows belong to the request
 * log and would otherwise inflate the totals — and every row carries the lane its
 * endpoint belongs to, which is what the live stream splits its boxes by.
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
				kind: serviceKindOf(r.endpoint),
				promptTokens: t.prompt_tokens || t.input_tokens || 0,
				completionTokens: t.completion_tokens || t.output_tokens || 0,
				cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
				status: (r.status as string) || "ok",
			}
		})
		.filter((e) => {
			if (!BILLED_STATUSES.has(e.status)) return false
			if (isModelAllowed && !isModelAllowed(e.model)) return false
			// A chat row that spent no tokens billed nothing, so it is noise here.
			// The media lanes are the exception: an image or a synthesised voice is
			// billed per unit and legitimately reports zero tokens, and dropping
			// those rows is what kept them off the live stream entirely.
			if (e.promptTokens === 0 && e.completionTokens === 0 && e.kind === "llm") return false
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
