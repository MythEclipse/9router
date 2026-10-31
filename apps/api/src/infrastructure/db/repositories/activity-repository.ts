/**
 * Drizzle-backed audit trail.
 *
 * Append-only by design: nothing in the app updates or deletes a row here, so a
 * mutation record cannot be rewritten after the fact.
 *
 * `list` is the reader half. It returns rows newest-first and leaves the payload as it was
 * stored: summarising (and redacting) is the use-case's job, so a row written by an older
 * caller cannot bypass it.
 */

import { desc } from "drizzle-orm"
import type { AuditRow } from "../../../application/audit/read-audit-log.ts"
import type { IActivityRepository } from "../../../application/dependencies.ts"
import type { Db } from "../client.ts"
import { activity } from "../schema.ts"

export function createActivityRepository(db: Db, newId: () => string): IActivityRepository {
	return {
		async record(entry) {
			await db.insert(activity).values({
				id: newId(),
				action: entry.action,
				subject: entry.subject,
				payload: entry.payload ? JSON.stringify(entry.payload) : null,
				at: entry.at,
			})
		},

		async list(limit): Promise<readonly AuditRow[]> {
			const rows = await db
				.select()
				.from(activity)
				.orderBy(desc(activity.at))
				.limit(Math.max(1, Math.trunc(limit)))
			return rows.map((row) => ({
				id: row.id,
				action: row.action,
				subject: row.subject,
				at: row.at,
				payload: parsePayload(row.payload),
			}))
		},
	}
}

/** The stored JSON, or an empty object when the column is empty or unreadable. */
function parsePayload(raw: string | null): unknown {
	if (!raw) return {}
	try {
		return JSON.parse(raw)
	} catch {
		// An unreadable payload still belongs to a real change: the row keeps its identity and
		// loses only its detail.
		return {}
	}
}
