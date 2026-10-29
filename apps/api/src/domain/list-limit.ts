/**
 * How many entries a dashboard list may return.
 *
 * `pxpipe/stats` and `pxpipe/logs` each wrote the same clamp inline and neither
 * said what a bad value means: `Number(searchParams.get("limit")) || 100` turns
 * `?limit=abc` into `NaN || 100`, so a caller who mistyped got the default and no
 * indication their value was not used. Worse, `?limit=-5` passed through —
 * `-5 || 100` is `-5` — and reached the store as a negative slice count, which
 * reads from the wrong end of the array.
 *
 * The clamp is now a rule with a name, and it reports whether it had to override
 * the caller so a route can say so.
 */

/** Entries returned when the caller names no limit. */
export const DEFAULT_LIST_LIMIT = 100

/** The ceiling, so one dashboard poll cannot ask for the whole history. */
export const MAX_LIST_LIMIT = 500

export interface ListLimit {
	readonly limit: number
	/** True when the caller's value was replaced or clamped. */
	readonly adjusted: boolean
}

/**
 * Read a `?limit=` value.
 *
 * Absent means the default. A non-integer, zero or negative value is reported as
 * `adjusted` and falls back to the default rather than being silently used or
 * silently ignored — a negative count is not a smaller list, it is a bug.
 */
export function readListLimit(raw: string | null | undefined): ListLimit {
	if (raw === null || raw === undefined || raw.trim() === "") {
		return { limit: DEFAULT_LIST_LIMIT, adjusted: false }
	}

	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
		return { limit: DEFAULT_LIST_LIMIT, adjusted: true }
	}
	if (parsed > MAX_LIST_LIMIT) {
		return { limit: MAX_LIST_LIMIT, adjusted: true }
	}
	return { limit: parsed, adjusted: false }
}
