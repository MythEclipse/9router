/**
 * Provider-connection deletes and maintenance.
 *
 * Extracted verbatim from connectionsRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { stringifyJson } from "../helpers/jsonCol.ts"
import type { ResolvedDbAdapter } from "../types.ts"

import { getCombos } from "./combosRepo.ts"
import { getModelInfoCoreSync, reorderInTx, rowToConn, upsert } from "./connectionsHelpers.ts"
import type { ProviderConnectionRecord, ProviderConnectionRow } from "./connectionsTypes.ts"

export async function deleteProviderConnection(id: string): Promise<boolean> {
	const db = await getAdapter()
	// Get provider before deleting
	const row = db.get<{ provider: string }>(`SELECT provider FROM providerConnections WHERE id = ?`, [
		id,
	])
	if (!row) return false
	const provider = row.provider

	let ok = false
	db.transaction(() => {
		const deleted = db.run(`DELETE FROM providerConnections WHERE id = ?`, [id])
		reorderInTx(db, provider)
		ok = deleted.changes > 0
	})

	// Cascade: clean up orphaned models in combos that reference this provider
	if (ok) {
		const combos = (await getCombos()) || []
		for (const combo of combos) {
			if (!combo.models || !Array.isArray(combo.models)) continue
			const originalLength = combo.models.length
			// Filter out models from the deleted provider
			// getCombos() returns combos to the caller as-is, so the stored model
			// strings are the raw ones; the filter only needs the synchronous shape.
			const filtered = combo.models.filter((modelStr: string) => {
				const info = getModelInfoCoreSync(modelStr)
				return info?.provider !== provider
			})
			if (filtered.length !== originalLength) {
				// Update combo with filtered models
				if (filtered.length === 0) {
					// Combo became empty - delete it to avoid 500 on use
					db.run(`DELETE FROM combos WHERE name = ?`, [combo.name])
				} else {
					db.run(`UPDATE combos SET models = ?, updatedAt = datetime('now') WHERE name = ?`, [
						stringifyJson(filtered),
						combo.name,
					])
				}
			}
		}
	}

	return ok
}

export async function deleteProviderConnectionsByProvider(providerId: string): Promise<number> {
	const db = await getAdapter()
	const before = db.get<{ n: number }>(
		`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`,
		[providerId],
	)
	db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId])
	return before?.n || 0
}

export async function reorderProviderConnections(providerId: string): Promise<void> {
	const db = await getAdapter()
	db.transaction(() => reorderInTx(db, providerId))
}

/**
 * The provider half of `getModelInfoCore` without alias resolution: a stored
 * combo model string is `provider/model` or `provider:model`, and only the
 * provider part decides whether the combo entry is orphaned.
 */

export async function cleanupProviderConnections() {
	const db = await getAdapter()
	const fieldsToCheck = [
		"displayName",
		"email",
		"globalPriority",
		"defaultModel",
		"accessToken",
		"refreshToken",
		"expiresAt",
		"tokenType",
		"scope",
		"projectId",
		"apiKey",
		"testStatus",
		"lastTested",
		"lastError",
		"lastErrorAt",
		"rateLimitedUntil",
		"expiresIn",
		"consecutiveUseCount",
	]
	let cleaned = 0
	db.transaction(() => {
		const rows = db.all<ProviderConnectionRow>(`SELECT * FROM providerConnections`)
		for (const row of rows) {
			const conn = rowToConn(row)
			let dirty = false
			for (const f of fieldsToCheck) {
				if (conn[f] === null || conn[f] === undefined) {
					if (f in conn) {
						delete conn[f]
						cleaned++
						dirty = true
					}
				}
			}
			if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
				delete conn.providerSpecificData
				cleaned++
				dirty = true
			}
			if (dirty) upsert(db, conn)
		}
	})
	return cleaned
}
