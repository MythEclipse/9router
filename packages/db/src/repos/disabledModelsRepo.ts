import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

const SCOPE = "disabledModels"

/** The stored model-id list for one provider; a missing/absent row reads as empty. */
function readModelIds(raw: string | undefined): string[] {
	return parseJson<string[]>(raw, []) || []
}

export async function getDisabledModels(): Promise<Record<string, unknown[]>> {
	const db = await getAdapter()
	const rows = db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = ?`, [
		SCOPE,
	])
	const out: Record<string, unknown[]> = {}
	for (const r of rows) out[r.key] = parseJson<unknown[]>(r.value, [])
	return out
}

export async function getDisabledByProvider(providerAlias: string): Promise<unknown[]> {
	const db = await getAdapter()
	const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		providerAlias,
	])
	return readModelIds(row?.value)
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModels(providerAlias: string, ids: string[]): Promise<void> {
	if (!providerAlias || !Array.isArray(ids)) return
	const db = await getAdapter()
	db.transaction(() => {
		const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
			SCOPE,
			providerAlias,
		])
		const current = readModelIds(row?.value)
		const merged = [...new Set([...current, ...ids])]
		db.run(
			`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
			[SCOPE, providerAlias, stringifyJson(merged)],
		)
	})
}

export async function enableModels(providerAlias: string, ids: string[]): Promise<void> {
	if (!providerAlias) return
	const db = await getAdapter()
	db.transaction(() => {
		if (!Array.isArray(ids) || ids.length === 0) {
			db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias])
			return
		}
		const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
			SCOPE,
			providerAlias,
		])
		const current = readModelIds(row?.value)
		const removeSet = new Set(ids)
		const next = current.filter((id) => !removeSet.has(id))
		if (next.length === 0) {
			db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias])
		} else {
			db.run(
				`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
				[SCOPE, providerAlias, stringifyJson(next)],
			)
		}
	})
}
