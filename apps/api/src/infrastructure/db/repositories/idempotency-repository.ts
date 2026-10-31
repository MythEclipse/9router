/**
 * Drizzle-backed idempotency store.
 *
 * The only operation that has to be atomic is `claim`, and it is expressed as an insert that
 * does nothing on conflict: the row's primary key is the claim, so two concurrent requests
 * cannot both create it and the loser is told so by an empty `returning()`. A read-then-insert
 * would have a window between the two where both callers see "fresh".
 */
import { and, eq, lt } from "drizzle-orm"
import type { IdempotencyStore } from "../../../application/idempotency/idempotency.ts"
import type { IdempotencyRecord } from "../../../domain/idempotency.ts"
import type { Db } from "../client.ts"
import { idempotencyKeys } from "../schema.ts"

type IdempotencyRow = typeof idempotencyKeys.$inferSelect

function toRecord(row: IdempotencyRow): IdempotencyRecord {
	return {
		state: row.state === "done" ? "done" : "in_progress",
		fingerprint: row.fingerprint,
		status: row.status ?? null,
		contentType: row.contentType ?? null,
		body: row.body ?? null,
		expiresAt: row.expiresAt.getTime(),
	}
}

export function createIdempotencyStore(db: Db): IdempotencyStore {
	return {
		async read(key) {
			const [row] = await db
				.select()
				.from(idempotencyKeys)
				.where(eq(idempotencyKeys.key, key))
				.limit(1)
			return row ? toRecord(row) : null
		},

		async claim(entry) {
			const created = await db
				.insert(idempotencyKeys)
				.values({
					key: entry.key,
					fingerprint: entry.fingerprint,
					state: "in_progress",
					status: null,
					contentType: null,
					body: null,
					createdAt: new Date(),
					expiresAt: new Date(entry.expiresAt),
				})
				.onConflictDoNothing()
				.returning({ key: idempotencyKeys.key })
			return created.length > 0
		},

		async complete(key, entry) {
			await db
				.update(idempotencyKeys)
				.set({
					state: "done",
					status: entry.status,
					contentType: entry.contentType,
					body: entry.body,
				})
				.where(eq(idempotencyKeys.key, key))
		},

		async release(key) {
			await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key))
		},

		async prune(now) {
			const removed = await db
				.delete(idempotencyKeys)
				.where(and(lt(idempotencyKeys.expiresAt, new Date(now))))
				.returning({ key: idempotencyKeys.key })
			return removed.length
		},
	}
}
