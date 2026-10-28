import { v4 as uuidv4 } from "uuid"
import { normalizeAllowList } from "@/shared/utils/keyAccess"
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import { invalidateApiKeyCache } from "./apiKeysRepo.ts"

function rowToCombo(row) {
	if (!row) return null
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		models: parseJson(row.models, []),
		// 0 means auto: the window follows the largest member model.
		contextWindow: Number(row.contextWindow) || 0,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

export async function getCombos() {
	const db = await getAdapter()
	const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`)
	return rows.map(rowToCombo)
}

export async function getComboById(id) {
	const db = await getAdapter()
	const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id])
	return rowToCombo(row)
}

export async function getComboByName(name) {
	const db = await getAdapter()
	const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name])
	return rowToCombo(row)
}

export async function createCombo(data) {
	const db = await getAdapter()
	const now = new Date().toISOString()
	const combo = {
		id: uuidv4(),
		name: data.name,
		kind: data.kind || null,
		models: data.models || [],
		contextWindow: Number(data.contextWindow) || 0,
		createdAt: now,
		updatedAt: now,
	}
	db.run(
		`INSERT INTO combos(id, name, kind, models, contextWindow, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
		[
			combo.id,
			combo.name,
			combo.kind,
			stringifyJson(combo.models),
			combo.contextWindow,
			combo.createdAt,
			combo.updatedAt,
		],
	)
	return combo
}

export async function updateCombo(id, data) {
	const db = await getAdapter()
	let result = null
	db.transaction(() => {
		const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id])
		if (!row) return
		const previousName = String(row.name ?? "")
		const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() }
		db.run(
			`UPDATE combos SET name = ?, kind = ?, models = ?, contextWindow = ?, updatedAt = ? WHERE id = ?`,
			[
				merged.name,
				merged.kind,
				stringifyJson(merged.models || []),
				Number(merged.contextWindow) || 0,
				merged.updatedAt,
				id,
			],
		)
		// Grants identify combos by NAME. A rename that left the old name in place
		// would silently revoke every restricted key's access to this combo — the
		// key keeps its grant on a name that no longer resolves, and the operator
		// sees "access denied" with nothing obviously changed. Carry the grant over
		// in the same transaction, exactly as deleteCombo revokes it.
		if (previousName && previousName.toLowerCase() !== String(merged.name ?? "").toLowerCase()) {
			renameComboGrants(db, previousName, String(merged.name ?? ""))
		}
		result = merged
	})
	invalidateApiKeyCache()
	return result
}

/** Rewrite every restricted key's allow list from `from` to `to` (case-insensitive). */
function renameComboGrants(db, from, to) {
	const oldName = from.toLowerCase()
	const keys = db.all(`SELECT id, accessAllow FROM apiKeys WHERE accessRestricted = 1`)
	for (const key of keys) {
		const allow = normalizeAllowList(parseJson(key.accessAllow, []))
		let changed = false
		const updated = allow.map((entry) => {
			if (entry.toLowerCase() !== oldName) return entry
			changed = true
			return to
		})
		if (!changed) continue
		db.run(`UPDATE apiKeys SET accessAllow = ? WHERE id = ?`, [
			stringifyJson(normalizeAllowList(updated)),
			key.id,
		])
	}
}

export async function deleteCombo(id) {
	const db = await getAdapter()
	return db.transaction(() => {
		const combo = db.get(`SELECT name FROM combos WHERE id = ?`, [id])
		if (!combo) return false

		const res = db.run(`DELETE FROM combos WHERE id = ?`, [id])
		if (!(res?.changes > 0)) return false

		// Grants identify combos by name, not DB id, and match case-insensitively.
		// Keep a grant if another case variant of the same combo name still exists.
		const name = String(combo.name).toLowerCase()
		if (
			db
				.all<{ name: string }>(`SELECT name FROM combos`)
				.some((c) => String(c.name).toLowerCase() === name)
		)
			return true

		// An orphan name can otherwise resolve as a model alias/provider, or grant a
		// newly created combo with the same name. Revoke it in the same transaction.
		const keys = db.all(`SELECT id, accessAllow FROM apiKeys WHERE accessRestricted = 1`)
		for (const key of keys) {
			const allow = normalizeAllowList(parseJson(key.accessAllow, []))
			const remaining = allow.filter((entry) => entry.toLowerCase() !== name)
			if (remaining.length === allow.length) continue
			// Never clear accessRestricted: an empty allow list must still deny all.
			db.run(`UPDATE apiKeys SET accessAllow = ? WHERE id = ?`, [stringifyJson(remaining), key.id])
		}
		invalidateApiKeyCache()
		return true
	})
}
