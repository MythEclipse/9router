import { getAdapter } from "../driver.ts"
import type { DbAdapter } from "../types.ts"

/**
 * One `_meta` value, or `fallback` when the key was never written.
 *
 * A generic value keeps the caller's own type: `getMeta<T>(key)` reads a row
 * that may have been written by any earlier version.
 */
export async function getMeta<T = string | null>(
	key: string,
	fallback: T | null = null,
): Promise<T | null> {
	const db = await getAdapter()
	const row = db.get<{ value: T }>(`SELECT value FROM _meta WHERE key = ?`, [key])
	return row ? row.value : fallback
}

export async function setMeta(key: string, value: unknown): Promise<void> {
	const db = await getAdapter()
	db.run(
		`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		[key, String(value)],
	)
}

// Sync versions for use during migration (adapter passed directly)
export function getMetaSync<T = string | null>(
	adapter: DbAdapter,
	key: string,
	fallback: T | null = null,
): T | null {
	const row = adapter.get<{ value: T }>(`SELECT value FROM _meta WHERE key = ?`, [key])
	return row ? row.value : fallback
}

export function setMetaSync(adapter: DbAdapter, key: string, value: unknown): void {
	adapter.run(
		`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		[key, String(value)],
	)
}
