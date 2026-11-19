/**
 * Retain bookkeeping for the memory stage, on the `kv` table.
 *
 * The stage retains only the *delta* of a conversation — messages newer than the
 * last index it sent — so it must remember that index per document. Without it,
 * every turn would re-send the whole transcript and Hindsight would re-extract
 * facts for messages it already has, which is both a duplicated bill and
 * duplicated memories.
 *
 * The index is stored as a count of messages, not a content hash: requests carry
 * the conversation in order, so "the first N messages have been retained" is
 * enough, and it survives a restart (which is the reason it is on disk at all —
 * an in-memory counter would re-retain everything after every deploy).
 *
 * A scope of its own (`memoryRetain`) keeps this out of the semantic cache's rows
 * in the same table.
 */
import { getAdapter } from "../driver.ts"
import type { DbRow } from "../types.ts"

const SCOPE = "memoryRetain"

/** How many leading messages of `documentId` have already been retained. */
export async function readRetainedCount(documentId: string): Promise<number> {
	try {
		const db = await getAdapter()
		const row = db.get<DbRow>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, documentId])
		const parsed = Number(row?.value)
		return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
	} catch {
		// A state row that cannot be read means "retain nothing extra", never a
		// failed chat request.
		return 0
	}
}

/** Record that the first `count` messages of `documentId` are now retained. */
export async function writeRetainedCount(documentId: string, count: number): Promise<void> {
	if (!Number.isFinite(count) || count <= 0) return
	try {
		const db = await getAdapter()
		db.run(
			`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
			 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
			[SCOPE, documentId, String(Math.trunc(count))],
		)
	} catch {
		// Losing the bookmark costs a duplicate extraction next turn; it must not
		// fail the request that carried the answer.
	}
}

/** Forget a document's bookmark (used when the document is deleted upstream). */
export async function dropRetainedCount(documentId: string): Promise<void> {
	try {
		const db = await getAdapter()
		db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, documentId])
	} catch {
		/* best effort */
	}
}
