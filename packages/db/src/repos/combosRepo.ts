import { normalizeAllowList } from "@9router/db/shared/keyAccess"
import { v4 as uuidv4 } from "uuid"
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import type { DbAdapter, DbParams, DbRow } from "../types.ts"
import { invalidateApiKeyCache } from "./apiKeysRepo.ts"

/** A model combo as the app sees it (`models` parsed out of the JSON column). */
export interface Combo {
	id: string
	name: string
	kind: string | null
	models: string[]
	/** 0 means auto: the window follows the largest member model. */
	contextWindow: number
	createdAt: string
	updatedAt: string
}

/** The fields a caller may set on a combo; `updateCombo` takes them partially. */
export interface ComboInput {
	name?: string
	kind?: string | null
	models?: string[]
	contextWindow?: number | string
}

/** A `combos` row: `models` arrives as a JSON string. */
interface ComboRow extends DbRow {
	id: string
	name: string
	kind?: string | null
	models?: string | null
	contextWindow?: number | string | null
	createdAt?: string
	updatedAt?: string
}

/** The `id`/`accessAllow` pair the grant reconciliation needs from `apiKeys`. */
interface GrantRow extends DbRow {
	id: string
	accessAllow?: string | null
}

function rowToCombo(row: ComboRow | null | undefined): Combo | null {
	if (!row) return null
	return {
		id: row.id,
		name: row.name,
		kind: row.kind ?? null,
		models: parseJson<string[]>(row.models, []),
		// 0 means auto: the window follows the largest member model.
		contextWindow: Number(row.contextWindow) || 0,
		createdAt: row.createdAt ?? "",
		updatedAt: row.updatedAt ?? "",
	}
}

function readKeyGrants(db: DbAdapter, sql: string, params?: DbParams): GrantRow[] {
	return db.all<GrantRow>(sql, params)
}

export async function getCombos(): Promise<Combo[]> {
	const db = await getAdapter()
	const rows = db.all<ComboRow>(`SELECT * FROM combos ORDER BY createdAt ASC`)
	return rows.map(rowToCombo).filter((combo): combo is Combo => combo !== null)
}

export async function getComboById(id: string): Promise<Combo | null> {
	const db = await getAdapter()
	const row = db.get<ComboRow>(`SELECT * FROM combos WHERE id = ?`, [id])
	return rowToCombo(row)
}

export async function getComboByName(name: string): Promise<Combo | null> {
	const db = await getAdapter()
	const row = db.get<ComboRow>(`SELECT * FROM combos WHERE name = ?`, [name])
	return rowToCombo(row)
}

export async function createCombo(data: ComboInput): Promise<Combo> {
	const db = await getAdapter()
	const now = new Date().toISOString()
	const combo: Combo = {
		id: uuidv4(),
		name: data.name ?? "",
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
		] as DbParams,
	)
	return combo
}

export async function updateCombo(id: string, data: ComboInput): Promise<Combo | null> {
	const db = await getAdapter()
	let result: Combo | null = null
	db.transaction(() => {
		const row = db.get<ComboRow>(`SELECT * FROM combos WHERE id = ?`, [id])
		if (!row) return
		const previousName = String(row.name ?? "")
		const merged: Combo = {
			...rowToCombo(row),
			...data,
			contextWindow: Number(data.contextWindow ?? row.contextWindow) || 0,
			updatedAt: new Date().toISOString(),
		}
		db.run(
			`UPDATE combos SET name = ?, kind = ?, models = ?, contextWindow = ?, updatedAt = ? WHERE id = ?`,
			[
				merged.name,
				merged.kind,
				stringifyJson(merged.models || []),
				Number(merged.contextWindow) || 0,
				merged.updatedAt,
				id,
			] as DbParams,
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
function renameComboGrants(db: DbAdapter, from: string, to: string) {
	const oldName = from.toLowerCase()
	const keys = readKeyGrants(db, `SELECT id, accessAllow FROM apiKeys WHERE accessRestricted = 1`)
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

export async function deleteCombo(id: string): Promise<boolean> {
	const db = await getAdapter()
	return db.transaction(() => {
		const combo = db.get<{ name?: string | null }>(`SELECT name FROM combos WHERE id = ?`, [id])
		if (!combo) return false

		const res = db.run(`DELETE FROM combos WHERE id = ?`, [id])
		if (!(res.changes > 0)) return false

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
		const keys = readKeyGrants(db, `SELECT id, accessAllow FROM apiKeys WHERE accessRestricted = 1`)
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
