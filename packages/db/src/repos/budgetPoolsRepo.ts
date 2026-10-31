/**
 * Budget pools, stored in the generic `kv` table under their own scope.
 *
 * A pool is a named cap shared by several API keys — "all my editor keys get $20 a month
 * between them". The per-key cap already exists on the key row; what was missing is the
 * grouping, and `002-drop-budget-groups.ts` records that an earlier attempt at one was removed.
 *
 * Stored as one JSON row rather than a table per pool: a pool has no identity of its own
 * outside this list, is written whole, and is small. A table would add a migration and an index
 * for a document that is read once per page.
 */
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

const SCOPE = "budgetPools"
const ROW_KEY = "pools"

/** One stored pool. Members are API key ids. */
export interface BudgetPoolRecord {
	id: string
	name: string
	/** The shared cap, in the same unit the member keys report (`limitKind`). */
	cap: number
	members: readonly string[]
}

export async function getBudgetPools(): Promise<BudgetPoolRecord[]> {
	const db = await getAdapter()
	const row = db.get<{ value: string }>(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
		SCOPE,
		ROW_KEY,
	])
	return parseJson<BudgetPoolRecord[]>(row?.value, []) || []
}

/** Replace the whole list. A partial write would leave two pools claiming one key. */
export async function saveBudgetPools(pools: readonly BudgetPoolRecord[]): Promise<void> {
	const db = await getAdapter()
	db.run(
		`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		[SCOPE, ROW_KEY, stringifyJson(pools)],
	)
}
