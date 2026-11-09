/**
 * Restore section types and small helpers.
 *
 * Extracted verbatim from restoreSections.ts.
 */

import type { ResolvedDbAdapter } from "./types.ts"

/** The narrow slice of the adapter a restore needs. */
export type RestoreDb = Pick<ResolvedDbAdapter, "all" | "run">

export interface SectionRestore {
	/** The stage name used for progress reporting. */
	name: string
	/** Payload fields that select this section; at least one must be present. */
	sectionKeys: readonly string[]
	/**
	 * Delete the table's current contents and insert the payload's.
	 *
	 * Only the fields present in `payload` are touched, so a backup written before a
	 * feature existed still restores cleanly.
	 */
	restore(db: RestoreDb, payload: Record<string, unknown>, context: RestoreContext): void
}

/**
 * What a restore needs from the caller beyond the payload.
 *
 * `existingApiKeys` is snapshotted before the wipe: a key row in an old backup carries
 * no limit columns, and restoring it must keep the live counters rather than zero them.
 */
export interface RestoreContext {
	existingApiKeys: Record<string, Record<string, unknown>>
}

export const now = () => new Date().toISOString()
export const json = (v: unknown) => JSON.stringify(v ?? null)
export const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** Delete a KV scope, then write the entries the payload carries for it. */
export function restoreKvScope(
	db: RestoreDb,
	scope: string,
	entries: Array<[string, unknown]>,
): void {
	db.run(`DELETE FROM kv WHERE scope = '${scope}'`)
	for (const [key, value] of entries) {
		db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('${scope}', ?, ?)`, [
			key,
			json(value),
		])
	}
}
