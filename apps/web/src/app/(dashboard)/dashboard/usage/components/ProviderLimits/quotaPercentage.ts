/**
 * The one place a quota percentage is computed.
 *
 * Remaining percentage is the number the usage UI colours and sorts by, and it is
 * derived in two places — while parsing a provider payload and while rendering a row.
 * A copy in each is how the two drift into disagreeing about the same bucket, so both
 * call this.
 */

/**
 * Remaining percentage of a bucket, where 100 means untouched and 0 means used up.
 *
 * The edges are deliberate: a missing total reads as 0 (nothing to measure against),
 * and a missing or negative `used` reads as 100 rather than trusting a bad number. A
 * used count at or past the total clamps to 0 instead of going negative, which would
 * otherwise render as a full bar. **`used` here is remaining** — the argument names
 * are inherited and the subtraction below is what turns "remaining" into a percent.
 */
export function calculatePercentage(
	used: number | null | undefined,
	total: number | null | undefined,
): number {
	if (!total || total === 0) return 0
	if (!used || (used as number) < 0) return 100
	if ((used as number) >= total) return 0

	return Math.round(((total - (used as number)) / total) * 100)
}
