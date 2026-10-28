/**
 * Drizzle-backed audit trail.
 *
 * Append-only by design: nothing in the app updates or deletes a row here, so a
 * mutation record cannot be rewritten after the fact.
 */

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
	}
}
