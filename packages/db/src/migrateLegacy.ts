// Legacy JSON import helpers — extracted verbatim from migrate.ts.
import fs from "node:fs"
import { stringifyJson } from "./helpers/jsonCol.ts"
import { getMetaSync, setMetaSync } from "./helpers/metaStore.ts"
import { MigrationAborted } from "./migrateTypes.ts"
import type { DbAdapter } from "./types.ts"
// Insert rows one-by-one, collect failures, then assert COUNT(*) matches input length.
export function importWithAssertion(
	adapter: DbAdapter,
	tableName: string,
	rows: Record<string, unknown>[],
	insertFn: (row: Record<string, unknown>) => void,
	rowMeta: (row: Record<string, unknown>) => Record<string, unknown>,
) {
	const dropped: unknown[] = []
	for (const row of rows) {
		try {
			insertFn(row)
		} catch (err) {
			dropped.push({ ...rowMeta(row), reason: err instanceof Error ? err.message : String(err) })
		}
	}
	const inserted = adapter.get(`SELECT COUNT(*) as c FROM ${tableName}`)?.c ?? 0
	if (inserted !== rows.length) {
		console.warn(
			`[DB][migrate] ${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}. Dropped:`,
			dropped,
		)
		throw new MigrationAborted(
			`${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}`,
			dropped,
		)
	}
}

/**
 * Legacy blobs store each section as an array of rows, and older exports omit
 * sections entirely. This narrows both cases without asserting a shape the
 * file cannot guarantee.
 */
export function legacyRows(blob: LegacyBlob, key: string): Record<string, unknown>[] {
	const value = blob[key]
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

/** Legacy export blob: arrays of rows under arbitrary top-level keys. */
type LegacyBlob = Record<string, unknown>

export function readJsonSafe(file: string): LegacyBlob | null {
	if (!fs.existsSync(file)) return null
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
		return parsed && typeof parsed === "object" ? (parsed as LegacyBlob) : null
	} catch {
		return null
	}
}

function isFreshDb(adapter: DbAdapter) {
	// Table _meta may not exist yet on truly fresh DB
	try {
		const row = adapter.get(`SELECT COUNT(*) as c FROM _meta`)
		return !row || row.c === 0
	} catch {
		return true
	}
}

// ─── Versioned migrations runner (skip-version safe) ─────────────────────
/** The message of a caught value, which strict typing leaves as `unknown`. */
function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

// ─── Legacy JSON import (one-time) ───────────────────────────────────────
export function importLegacyMain(adapter: DbAdapter, data: Record<string, unknown> | null) {
	if (!data) return
	if (!data || typeof data !== "object") return

	if (data.settings) {
		adapter.run(
			`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
			[stringifyJson(data.settings)],
		)
	}

	importWithAssertion(
		adapter,
		"providerConnections",
		legacyRows(data, "providerConnections"),
		(c) => {
			const {
				id,
				provider,
				authType,
				name,
				email,
				priority,
				isActive,
				createdAt,
				updatedAt,
				...rest
			} = c
			adapter.run(
				`INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					provider,
					authType || "oauth",
					name || null,
					email || null,
					priority || null,
					isActive === false ? 0 : 1,
					stringifyJson(rest),
					createdAt || new Date().toISOString(),
					updatedAt || new Date().toISOString(),
				],
			)
		},
		(c) => ({ id: c.id ?? null, provider: c.provider ?? null, name: c.name ?? null }),
	)

	importWithAssertion(
		adapter,
		"providerNodes",
		legacyRows(data, "providerNodes"),
		(n) => {
			const { id, type, name, createdAt, updatedAt, ...rest } = n
			adapter.run(
				`INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
				[
					id,
					type || null,
					name || null,
					stringifyJson(rest),
					createdAt || new Date().toISOString(),
					updatedAt || new Date().toISOString(),
				],
			)
		},
		(n) => ({ id: n.id ?? null, type: n.type ?? null, name: n.name ?? null }),
	)

	importWithAssertion(
		adapter,
		"proxyPools",
		legacyRows(data, "proxyPools"),
		(p) => {
			const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p
			adapter.run(
				`INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
				[
					id,
					isActive === false ? 0 : 1,
					testStatus || "unknown",
					stringifyJson(rest),
					createdAt || new Date().toISOString(),
					updatedAt || new Date().toISOString(),
				],
			)
		},
		(p) => ({ id: p.id ?? null }),
	)

	importWithAssertion(
		adapter,
		"apiKeys",
		legacyRows(data, "apiKeys"),
		(k) => {
			adapter.run(
				`INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
				[
					k.id,
					k.key,
					k.name || null,
					k.machineId || null,
					k.isActive === false ? 0 : 1,
					k.createdAt || new Date().toISOString(),
				],
			)
		},
		(k) => ({ id: k.id ?? null, name: k.name ?? null }),
	)

	importWithAssertion(
		adapter,
		"combos",
		legacyRows(data, "combos"),
		(c) => {
			adapter.run(
				`INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
				[
					c.id,
					c.name,
					c.kind || null,
					stringifyJson(c.models || []),
					c.createdAt || new Date().toISOString(),
					c.updatedAt || new Date().toISOString(),
				],
			)
		},
		(c) => ({ id: c.id ?? null, name: c.name ?? null }),
	)

	for (const [alias, model] of Object.entries(data.modelAliases || {})) {
		adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [
			alias,
			stringifyJson(model),
		])
	}
	for (const m of legacyRows(data, "customModels")) {
		const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`
		adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [
			k,
			stringifyJson(m),
		])
	}
	for (const [tool, mappings] of Object.entries(data.mitmAlias || {})) {
		adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [
			tool,
			stringifyJson(mappings || {}),
		])
	}
	for (const [provider, models] of Object.entries(data.pricing || {})) {
		adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [
			provider,
			stringifyJson(models || {}),
		])
	}
}

export function importLegacyUsage(adapter: DbAdapter, data: Record<string, unknown> | null) {
	if (!data) return
	if (!data || typeof data !== "object") return
	for (const e of legacyRows(data, "history")) {
		const t = (e.tokens || {}) as Record<string, unknown>
		const num = (v: unknown): number => (typeof v === "number" ? v : 0)
		adapter.run(
			`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				e.timestamp || new Date().toISOString(),
				e.provider || null,
				e.model || null,
				e.connectionId || null,
				e.apiKey || null,
				e.endpoint || null,
				num(t.prompt_tokens) || num(t.input_tokens) || 0,
				num(t.completion_tokens) || num(t.output_tokens) || 0,
				e.cost || 0,
				e.status || "ok",
				stringifyJson(t),
				stringifyJson({}),
			],
		)
	}
	for (const [dateKey, day] of Object.entries(data.dailySummary || {})) {
		adapter.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
			dateKey,
			stringifyJson(day),
		])
	}
	if (typeof data.totalRequestsLifetime === "number") {
		setMetaSync(adapter, "totalRequestsLifetime", data.totalRequestsLifetime)
	}
}

export function importLegacyDisabled(adapter: DbAdapter, data: Record<string, unknown> | null) {
	if (!data || typeof data.disabled !== "object" || !data.disabled) return
	for (const [provider, ids] of Object.entries(data.disabled as Record<string, unknown>)) {
		adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [
			provider,
			stringifyJson(ids || []),
		])
	}
}

export function importLegacyDetails(adapter: DbAdapter, data: Record<string, unknown> | null) {
	if (!data) return
	if (!data || !Array.isArray(data.records)) return
	for (const r of data.records) {
		adapter.run(
			`INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
			[
				r.id,
				r.timestamp || new Date().toISOString(),
				r.provider || null,
				r.model || null,
				r.connectionId || null,
				r.status || null,
				stringifyJson(r),
			],
		)
	}
}
