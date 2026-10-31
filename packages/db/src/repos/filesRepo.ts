/**
 * Uploaded files, stored as base64 in the `kv` table under their own scope.
 *
 * A row per file, keyed by the file id. Base64 costs a third of the payload in space and is the
 * only encoding that survives a TEXT column intact — and it keeps the store portable: the same
 * database file carries the uploads, so a backup that restores the keys restores the files.
 *
 * The 8 MB cap in `domain/openai-files` is what keeps this honest. A larger upload belongs in
 * object storage, not in a row that is read whole on every fetch.
 */
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

const SCOPE = "files"

/** One stored upload: its metadata and the bytes, base64-encoded. */
interface StoredFile {
	readonly meta: Record<string, unknown>
	readonly data: string
}

export async function putFile(
	id: string,
	meta: Record<string, unknown>,
	bytes: Uint8Array,
): Promise<void> {
	const db = await getAdapter()
	const record: StoredFile = { meta, data: Buffer.from(bytes).toString("base64") }
	db.run(
		`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		[SCOPE, id, stringifyJson(record)],
	)
}

/** The bytes and metadata of one file, or `null` when the id is unknown. */
export async function getFile(
	id: string,
): Promise<{ meta: Record<string, unknown>; bytes: Uint8Array } | null> {
	const db = await getAdapter()
	const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		id,
	])
	const record = parseJson<StoredFile | null>(row?.value, null)
	if (!record) return null
	return { meta: record.meta, bytes: new Uint8Array(Buffer.from(record.data, "base64")) }
}

/** Every stored file's metadata, newest first. */
export async function listFiles(): Promise<Record<string, unknown>[]> {
	const db = await getAdapter()
	const rows = db.all<{ value: string }>(`SELECT value FROM kv WHERE scope = ?`, [SCOPE])
	const metas = rows
		.map((row) => parseJson<StoredFile | null>(row.value, null)?.meta)
		.filter((meta): meta is Record<string, unknown> => Boolean(meta))
	return metas.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
}

/** Remove one file. Answers whether a row was there to remove. */
export async function deleteFile(id: string): Promise<boolean> {
	const db = await getAdapter()
	const existing = db.get<{ key: string }>(`SELECT key FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		id,
	])
	if (!existing) return false
	db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id])
	return true
}
