/**
 * The settings audit trail: what a change replaced, and putting it back.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeSettingsHistory`, registered
 *     as `settingsHistory`)
 *   - `apps/web/src/app/api/settings/history/route.ts` (list, read one)
 *   - `apps/web/src/app/api/settings/rollback/route.ts` (revert)
 *   - `tests/unit/use-case-settings-history.test.ts`
 *
 * No existing file serves this purpose: `manage-settings.ts` owns the row's
 * general read and write and only *records* a before-image through a callback.
 * This is the read side of that table plus the revert that consumes it; the two
 * rules deciding who may look and what a revert restores live in
 * `domain/settings.ts`.
 *
 * Reads: the history table (`id`, `snapshot`, `at`, `actor`, `reason`). Writes: the
 * settings row, a before-image of the revert itself, and a security event —
 * undoing a revert must be possible and every undo must appear in the trail.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import { invalid, unauthorized } from "../../domain/errors.ts"
import { mayRevertSettings, revertIsEmpty, revertPatchOf } from "../../domain/settings.ts"

/**
 * A row of the trail, as the list reads it.
 *
 * The list carries the snapshot's *key names* only: the dashboard shows what a
 * change touched, and shipping every before-image to a list view would send the
 * whole configuration for each row.
 */
export interface HistoryRow {
	readonly id: string
	readonly at?: string | null
	readonly actor?: string | null
	readonly reason?: string | null
	readonly keys: string[]
}

/** One row in full, as a revert needs it. */
export interface HistoryEntry {
	readonly id: string
	readonly snapshot: Record<string, unknown>
	readonly at?: string | null
	readonly actor?: string | null
	readonly reason?: string | null
}

export interface SettingsHistoryDependencies {
	readonly history: {
		list(): Promise<HistoryRow[]>
		count(): Promise<number>
		find(id: string): Promise<HistoryEntry | null>
	}
	/** Drop anything that must never be restored, before it reaches the row. */
	readonly sanitize: (patch: Record<string, unknown>) => Record<string, unknown>
	readonly settings: {
		read(): Promise<Record<string, unknown>>
		update(changes: Record<string, unknown>): Promise<void>
	}
	readonly snapshot: (
		before: Record<string, unknown>,
		actor: string,
		reason: string,
	) => Promise<void>
	readonly recordSecurityEvent: (event: {
		type: string
		severity: string
		actor: string
		method: string
		path: string
		status: number
		detail: string
	}) => Promise<void>
	/** Strip the two secrets from anything answered to a browser. */
	readonly redact: (settings: Record<string, unknown>) => Record<string, unknown>
}

export interface HistoryReader {
	readonly role?: string | null
}

export interface RevertRequest extends HistoryReader {
	readonly id: string
	/** Limit the revert to these keys; omitted restores the whole snapshot. */
	readonly keys?: unknown
}

export function makeSettingsHistory({
	history,
	sanitize,
	settings,
	snapshot,
	recordSecurityEvent,
	redact,
}: SettingsHistoryDependencies) {
	return {
		/**
		 * The trail, newest first, with its total.
		 *
		 * The total comes from a separate count so the list can be paged later
		 * without the count depending on the page size.
		 */
		async list({ role }: HistoryReader): Promise<{ history: HistoryRow[]; total: number }> {
			assertMayRead(role)
			const [entries, total] = await Promise.all([history.list(), history.count()])
			return { history: entries, total }
		},

		/** One entry's full before-image, so the caller can show what a revert would apply. */
		async read({ id, role }: RevertRequest): Promise<{ snapshot: HistoryEntry }> {
			assertMayRead(role)
			if (!id) throw invalid("Missing history id")
			const entry = await history.find(id)
			if (!entry) throw invalid("History entry not found")
			return { snapshot: entry }
		},

		/**
		 * Put one snapshot back.
		 *
		 * The current row is recorded first, so the revert is itself revertible and
		 * shows up in the trail like any other change. `sanitize` runs after the
		 * subset is chosen: a stored entry cannot resurrect a password or a token,
		 * because those keys are dropped on the way out.
		 */
		async revert({ id, keys, role }: RevertRequest): Promise<{
			restored: string[]
			settings: Record<string, unknown>
		}> {
			if (!mayRevertSettings(role)) {
				throw unauthorized("Only a password sign-in can revert settings")
			}
			if (!id) throw invalid("Missing history id")

			const entry = await history.find(id)
			if (!entry) throw invalid("History entry not found")

			const patch = sanitize(revertPatchOf(entry.snapshot, keys))
			if (revertIsEmpty(patch)) throw invalid("Nothing to restore from this snapshot")

			const restored = Object.keys(patch)
			await snapshot(await settings.read(), `revert of ${id}`, restored.join(", "))
			await settings.update(patch)

			await recordSecurityEvent({
				type: "settings_changed",
				severity: "info",
				actor: "Password user (rollback)",
				method: "POST",
				path: "/api/settings/rollback",
				status: 200,
				detail: `Restored ${restored.length} setting(s) from ${entry.at}: ${restored.join(", ")}`,
			})

			return { restored, settings: redact(await settings.read()) }
		},
	}

	/**
	 * History is readable by any signed-in session.
	 *
	 * A key-signed session may read it — the table holds no secret and the dashboard
	 * shows it — but may not revert. An unauthenticated caller gets 401 rather than
	 * 403: there is nothing to forbid until someone has signed in.
	 */
	function assertMayRead(role: string | null | undefined): void {
		if (!role) throw unauthorized("Unauthorized")
	}
}
