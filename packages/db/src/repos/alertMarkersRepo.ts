/**
 * Which notifications have already left the box.
 *
 * Stored as one JSON list under its own `kv` scope. The list is bounded by the caller (the feed
 * keeps a fixed window), and pruning happens on write: a marker that can no longer match a
 * notification is dead weight in a table that is read on every dispatch.
 */
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

const SCOPE = "alertMarkers"
const ROW_KEY = "sent"

/** How many markers are kept. The feed's own window is 200, so this cannot lag behind it. */
export const MARKER_LIMIT = 500

export async function getAlertMarkers(): Promise<string[]> {
	const db = await getAdapter()
	const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		ROW_KEY,
	])
	return parseJson<string[]>(row?.value, []) || []
}

/** Add markers, keeping the newest `MARKER_LIMIT` and never duplicating one. */
export async function recordAlertMarkers(markers: readonly string[]): Promise<void> {
	if (markers.length === 0) return
	const db = await getAdapter()
	const existing = await getAlertMarkers()
	const merged = [...new Set([...existing, ...markers])].slice(-MARKER_LIMIT)
	db.run(
		`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		[SCOPE, ROW_KEY, stringifyJson(merged)],
	)
}
