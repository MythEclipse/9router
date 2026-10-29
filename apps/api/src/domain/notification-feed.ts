/**
 * The notification feed's write actions.
 *
 * `POST /api/notifications` takes three shapes and they are easy to confuse, because all of them
 * describe "a notice goes away":
 *
 * - `{action: "read", id}` marks one row read; **without an id it means every row**, which is what
 *   the "mark all read" button sends.
 * - `{action: "clear", id}` dismisses one row the operator swiped away.
 * - `{action: "clear", kind, dedupeKey}` retires *a condition that stopped being true* — possibly
 *   a row the operator never saw. This is not the same as dismissing a row: it is the scan saying
 *   the problem is over.
 *
 * The reason this lives here rather than inline: getting the `clear` shapes backwards silences a
 * live condition (dismissing the row) instead of retiring a dead one, so the operator stops being
 * warned about a budget they are still over.
 */

/** What the feed should do with one POST body. */
export type NotificationCommand =
	| { readonly action: "read"; readonly id: string | null }
	| { readonly action: "clear-row"; readonly id: string }
	| {
			readonly action: "clear-condition"
			readonly kind: string
			readonly dedupeKey: string | undefined
	  }
	| { readonly action: "unknown" }

/**
 * Reads the requested action out of a body.
 *
 * `read` with no id is "all", not "nothing": that is the mark-all-read button, and treating it as
 * a no-op leaves the badge stuck at a count the operator already dismissed.
 */
export function notificationCommand(body: unknown): NotificationCommand {
	const record = (body ?? {}) as Record<string, unknown>
	const action = String(record.action ?? "")

	if (action === "read") {
		const id = record.id ? String(record.id) : ""
		return { action: "read", id: id || null }
	}

	if (action === "clear") {
		const id = record.id ? String(record.id) : ""
		if (id) return { action: "clear-row", id }
		return {
			action: "clear-condition",
			kind: String(record.kind ?? ""),
			dedupeKey: record.dedupeKey === undefined ? undefined : String(record.dedupeKey),
		}
	}

	return { action: "unknown" }
}

/**
 * The feed's page size, or undefined for the repo default.
 *
 * A non-numeric `?limit=` is dropped rather than turned into `NaN`: `Number("abc")` is NaN, and a
 * NaN limit reaches the query as an offset the adapter cannot bind.
 */
export function notificationLimit(raw: unknown): number | undefined {
	if (raw === null || raw === undefined || raw === "") return undefined
	const limit = Number(raw)
	return Number.isFinite(limit) && limit > 0 ? limit : undefined
}

/**
 * Whether a session may read the feed.
 *
 * A key session is refused: these messages name quota pressure and failed attempts against this
 * install, which is administrator information. 401 rather than 403 — the dashboard treats 401 as
 * "sign in again" and a key session cannot sign in, so it must not be told to.
 */
export function canReadNotifications(session: unknown): boolean {
	if (session === null || session === undefined) return false
	// The session type is a closed JWT payload, so the role is read off an open record rather than
	// widening the parameter into something the caller cannot satisfy.
	const role = (session as { role?: unknown }).role
	return role !== "apikey"
}
