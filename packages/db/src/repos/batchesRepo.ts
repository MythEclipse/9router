/**
 * Batches, stored in `kv` under their own scope.
 *
 * A batch row holds its metadata and its request lines: the lines are needed while the job runs,
 * and dropping them after completion would leave an output file nobody can trace back to an
 * input. The row is small by construction — `MAX_BATCH_LINES` caps it.
 */
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

const SCOPE = "batches"

/** What a stored batch holds. */
export interface StoredBatch {
	meta: Record<string, unknown>
	lines: Array<{ custom_id: string; body: unknown }>
	output: string[]
	errors: string[]
}

export async function putBatch(id: string, record: StoredBatch): Promise<void> {
	const db = await getAdapter()
	db.run(
		`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		[SCOPE, id, stringifyJson(record)],
	)
}

export async function getBatch(id: string): Promise<StoredBatch | null> {
	const db = await getAdapter()
	const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		id,
	])
	return parseJson<StoredBatch | null>(row?.value, null)
}

/** Every batch's metadata, newest first. */
export async function listBatches(): Promise<Record<string, unknown>[]> {
	const db = await getAdapter()
	const rows = db.all<{ value: string }>(`SELECT value FROM kv WHERE scope = ?`, [SCOPE])
	const metas = rows
		.map((row) => parseJson<StoredBatch | null>(row.value, null)?.meta)
		.filter((meta): meta is Record<string, unknown> => Boolean(meta))
	return metas.sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
}

export async function deleteBatch(id: string): Promise<boolean> {
	const db = await getAdapter()
	const existing = db.get<{ key: string }>(`SELECT key FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		id,
	])
	if (!existing) return false
	db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id])
	return true
}
