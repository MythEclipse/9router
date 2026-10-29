/**
 * Reporting periods for the usage endpoints.
 *
 * Four handlers had grown their own answer to "what does `period=30d` mean":
 *
 *  - `stats`, `chart`, `sparks` each kept their own `VALID_PERIODS` set and
 *    rejected anything else, defaulting to `7d` (or `30d` in two of them).
 *  - `errors` had a `PERIOD_MS` table and fell back to `7d` for an unrecognised
 *    value, so `?period=garbage` quietly returned a week of data that looked
 *    exactly like a correct answer.
 *  - `leaderboard` did not check the value at all and treated anything
 *    unrecognised as `7d` too.
 *
 * The fallback is the part worth removing. A caller who asked for 90 days and
 * got 7 has no way to tell, and the dashboard would label the chart with the
 * period it asked for. An unusable period is now an error at the boundary.
 */

/** The periods this dashboard understands. One list. */
export const REPORTING_PERIODS = ["today", "24h", "7d", "30d", "60d", "all"] as const

export type ReportingPeriod = (typeof REPORTING_PERIODS)[number]

/** What a caller who named no period gets. */
export const DEFAULT_PERIOD: ReportingPeriod = "7d"

/**
 * The default differs by endpoint on purpose in one case: the sparkline card
 * shows a month of shape, not a week, because a week of two daily points is not
 * a line.
 */
export const DEFAULT_SPARKS_PERIOD: ReportingPeriod = "30d"
/** The token-saver report is a monthly statement. */
export const DEFAULT_TOKEN_SAVINGS_PERIOD: ReportingPeriod = "30d"
/** The live stream opens on the current day. */
export const DEFAULT_STREAM_PERIOD: ReportingPeriod = "today"

export type PeriodResult =
	| { readonly ok: true; readonly period: ReportingPeriod }
	| { readonly ok: false; readonly message: string }

/**
 * Narrows a period answer to its refusal branch.
 *
 * A predicate rather than `if (!result.ok)` because `apps/web` compiles with
 * `strict: false`, where a discriminated union does not narrow through a boolean
 * discriminant. Same reason `isMitmFailure` and `isPageFailure` exist.
 */
export function isPeriodRefused(
	result: PeriodResult,
): result is { readonly ok: false; readonly message: string } {
	return !result.ok
}

/**
 * Resolve a requested period, or refuse it.
 *
 * `undefined` and `null` mean "the caller named none" and take the default; an
 * empty string is treated the same way, because `?period=` is how a form with a
 * blank field arrives and refusing it would break a working page.
 */
export function resolvePeriod(
	requested: unknown,
	fallback: ReportingPeriod = DEFAULT_PERIOD,
): PeriodResult {
	if (requested === undefined || requested === null || requested === "") {
		return { ok: true, period: fallback }
	}
	if (typeof requested !== "string") {
		return { ok: false, message: "Invalid period" }
	}
	const normalised = requested.trim().toLowerCase()
	if (normalised === "") return { ok: true, period: fallback }
	if (!isReportingPeriod(normalised)) {
		return { ok: false, message: "Invalid period" }
	}
	return { ok: true, period: normalised }
}

export function isReportingPeriod(value: string): value is ReportingPeriod {
	return (REPORTING_PERIODS as readonly string[]).includes(value)
}

/** Milliseconds in each bounded period, for the endpoints that build a cutoff. */
const PERIOD_MS: Readonly<Record<Exclude<ReportingPeriod, "today" | "all">, number>> = {
	"24h": 86_400_000,
	"7d": 604_800_000,
	"30d": 2_592_000_000,
	"60d": 5_184_000_000,
}

/**
 * The ISO instant a period starts at, or `null` for "everything".
 *
 * `today` means local midnight, not 24 hours ago: a dashboard that says "today"
 * and shows a rolling day disagrees with the calendar it is displayed next to.
 * The caller passes `now` so the answer is testable.
 */
export function periodCutoff(period: ReportingPeriod, now: Date): string | null {
	if (period === "all") return null
	if (period === "today") {
		const startOfDay = new Date(now.getTime())
		startOfDay.setHours(0, 0, 0, 0)
		return startOfDay.toISOString()
	}
	return new Date(now.getTime() - PERIOD_MS[period]).toISOString()
}

/**
 * The model scope to filter by, from an unknown session payload.
 *
 * `"*"` means unrestricted and is what the repo helpers expect; anything that is
 * not a string is treated as unrestricted rather than as a filter that matches
 * nothing, because the latter would show an empty dashboard to a session that
 * should see everything.
 */
export function modelScopeOf(value: unknown): string {
	return typeof value === "string" && value.trim() !== "" ? value : "*"
}

/** The API-key filter, or `null` for a session that sees every key. */
export function keyFilterOf(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null
}
