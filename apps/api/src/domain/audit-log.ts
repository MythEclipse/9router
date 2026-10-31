/**
 * The audit log: what an operator changed, and who they were.
 *
 * The install already records *security* events (a failed login, a refused key) in
 * `securityEvents`. It recorded almost nothing about *changes*: two write paths called the
 * activity repository (creating a key, editing one) and every other admin mutation — a deleted
 * provider connection, a rewritten budget, a swapped pricing table — left no trace beyond the
 * row it altered. "Who removed this?" was unanswerable, and the answer is not in the diff
 * because the diff is gone.
 *
 * Three rules, because an audit log fails in three directions:
 *
 * 1. **The action name is a closed vocabulary, not free text.** A log where one caller writes
 *    `provider.update` and another `updated provider` cannot be filtered, and the filter is the
 *    only reason anyone opens it. Names are `resource.verb`, lower case.
 * 2. **The payload is a summary, never the row.** Copying the whole record turns the audit log
 *    into a second copy of the database — including the credentials that were the point of the
 *    change. Only identifiers and the field names that moved are kept.
 * 3. **A read is not an event.** Nothing here records reads: a log that fills with `list` calls
 *    buries the one line that matters.
 */

/** How many entries one page may ask for. */
export const AUDIT_LOG_DEFAULT_LIMIT = 100

/** The ceiling a caller cannot exceed, so one page cannot read the whole table. */
export const AUDIT_LOG_MAX_LIMIT = 500

export interface AuditEntry {
	readonly id: string
	readonly action: string
	readonly subject: string
	/** ISO instant of the change. */
	readonly at: string
	/** The summarised payload, already stripped of secrets by the writer. */
	readonly detail: Record<string, unknown>
	/** The `resource` half of the action, for grouping the list. */
	readonly resource: string
	/** The `verb` half. */
	readonly verb: string
}

export type AuditLimitResult =
	| { readonly ok: true; readonly limit: number }
	| { readonly ok: false; readonly message: string }

/**
 * Narrows a limit answer to its refusal branch.
 *
 * A predicate rather than `if (!result.ok)`, because `apps/web` compiles with `strict: false`
 * and a discriminated union does not narrow through a boolean discriminant there — the same
 * reason `isPeriodRefused` exists for reporting periods.
 */
export function isAuditLimitRefused(
	result: AuditLimitResult,
): result is { readonly ok: false; readonly message: string } {
	return !result.ok
}

/**
 * Resolve `?limit=`.
 *
 * Absent means the page default; a value above the ceiling is clamped rather than refused (a
 * caller asking for more is not making a mistake), but a value that is not a positive number is
 * refused, because `?limit=abc` silently answering 100 looks like a working filter.
 */
export function resolveAuditLimit(raw: unknown): AuditLimitResult {
	if (raw === undefined || raw === null || raw === "") {
		return { ok: true, limit: AUDIT_LOG_DEFAULT_LIMIT }
	}
	const value = typeof raw === "number" ? raw : Number(String(raw).trim())
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return { ok: false, message: "limit must be a positive integer" }
	}
	return { ok: true, limit: Math.min(value, AUDIT_LOG_MAX_LIMIT) }
}

/**
 * Split an action into its resource and verb.
 *
 * An action that does not follow `resource.verb` is not repaired here — the raw string is kept
 * as the resource and the verb is `unknown`, so a malformed name is visible in the list instead
 * of being silently normalised into something that looks deliberate.
 */
export function describeAction(action: string): { resource: string; verb: string } {
	const trimmed = action.trim()
	const dot = trimmed.indexOf(".")
	if (dot <= 0 || dot === trimmed.length - 1)
		return { resource: trimmed || "unknown", verb: "unknown" }
	return { resource: trimmed.slice(0, dot), verb: trimmed.slice(dot + 1) }
}

/**
 * A payload reduced to what an audit reader needs.
 *
 * Field *names* survive, values do not, except for the few scalars that identify the change
 * (an id, a count, a boolean). That asymmetry is the point: "the budget changed" is the fact;
 * the previous and next numbers are already in the settings history table, which exists for
 * exactly that and is written by the code that knows how to redact it.
 */
const KEPT_SCALAR_KEYS = new Set([
	"id",
	"name",
	"count",
	"enabled",
	"active",
	"deleted",
	"created",
	"updated",
	"fields",
	"kind",
	"model",
	"provider",
])

export function summarisePayload(payload: unknown): Record<string, unknown> {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {}
	const summary: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (KEPT_SCALAR_KEYS.has(key)) {
			if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
				summary[key] = value
			} else if (Array.isArray(value)) {
				summary[key] = value.filter((item) => typeof item === "string").slice(0, 20)
			}
			continue
		}
		// Everything else contributes its name only: the reader learns which fields were
		// involved without the log becoming a copy of the credentials.
		summary[`changed:${key}`] = true
	}
	return summary
}
