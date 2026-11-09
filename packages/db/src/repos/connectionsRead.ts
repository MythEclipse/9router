/**
 * Provider-connection reads.
 *
 * Extracted verbatim from connectionsRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import type { ResolvedDbAdapter } from "../types.ts"

import { reorderInTx, rowToConn } from "./connectionsHelpers.ts"
import type { ProviderConnectionRecord, ProviderConnectionRow } from "./connectionsTypes.ts"

export async function getProviderConnections(
	filter: { provider?: string; isActive?: boolean } = {},
): Promise<ProviderConnectionRecord[]> {
	const db = await getAdapter()
	const where: string[] = []
	const params: unknown[] = []
	if (filter.provider) {
		where.push("provider = ?")
		params.push(filter.provider)
	}
	if (filter.isActive !== undefined) {
		where.push("isActive = ?")
		params.push(filter.isActive ? 1 : 0)
	}
	const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`
	const rows = db.all<ProviderConnectionRow>(sql, params)
	const list = rows.map(rowToConn)
	list.sort((a, b) => (a.priority || 999) - (b.priority || 999))
	return list
}

export async function getProviderConnectionById(
	id: string,
): Promise<ProviderConnectionRecord | null> {
	const db = await getAdapter()
	const row = db.get<ProviderConnectionRow>(`SELECT * FROM providerConnections WHERE id = ?`, [id])
	return row ? rowToConn(row) : null
}

// Internal sync reorder - must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// import O(1) per key instead of O(pool) - see createProviderConnection.
