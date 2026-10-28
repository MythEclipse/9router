/**
 * Error-log read rules.
 *
 * Pure: no database, no HTTP. The limit a client asks for is a request to be
 * honoured or refused, never a value to pass straight through — the handler
 * used to do `parseInt(param || "200")`, and `parseInt("abc")` is `NaN`, which
 * reaches the query as a bind value rather than an error.
 */

/** How many rows a caller gets when it does not say. */
export const DEFAULT_ERROR_LOG_LIMIT = 200

/**
 * Upper bound on a single page.
 *
 * The table is capped at 1000 rows by its own writer, so asking for more than
 * that can only scan the whole thing to return the same set.
 */
export const MAX_ERROR_LOG_LIMIT = 1000

export interface ErrorLogLimit {
	readonly limit: number
	/**
	 * True when the caller's value was clamped or replaced, so the caller can
	 * tell "you got 1000 because that is all there is" from "you asked for 5000".
	 */
	readonly adjusted: boolean
}

/**
 * Resolve a requested limit to one the query can run.
 *
 * Absent, non-numeric, zero, or negative values fall back to the default rather
 * than erroring: this is a read of diagnostics, and a dashboard sending a bad
 * page size should still see its logs. Values above the ceiling are clamped,
 * because silently returning fewer rows than asked is worse than saying so —
 * hence {@link ErrorLogLimit.adjusted}.
 */
export function resolveErrorLogLimit(requested: unknown): ErrorLogLimit {
	if (requested === null || requested === undefined || requested === "") {
		return { limit: DEFAULT_ERROR_LOG_LIMIT, adjusted: false }
	}

	const parsed = typeof requested === "number" ? requested : Number(String(requested).trim())

	// `Number("")` is 0 and `Number(" ")` is 0, both already filtered above; a
	// non-finite result is the caller sending words where a count belongs.
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		return { limit: DEFAULT_ERROR_LOG_LIMIT, adjusted: true }
	}

	if (parsed > MAX_ERROR_LOG_LIMIT) {
		return { limit: MAX_ERROR_LOG_LIMIT, adjusted: true }
	}

	return { limit: parsed, adjusted: false }
}
