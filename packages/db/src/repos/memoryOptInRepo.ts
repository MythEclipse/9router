/**
 * Which API keys opted in to the memory stage.
 *
 * Kept in `kv` rather than a column on `apiKeys` on purpose: this is a per-key
 * feature flag for one optional stage, and a migration is a permanent schema
 * commitment for something an operator may switch back off tomorrow. The existing
 * repo convention already stores small per-entity flags this way.
 *
 * Keyed by the key's **id**, not the secret: ids are stable across a key rotation
 * and never end up in a log line the way a secret would.
 */
import { getAdapter } from "../driver.ts"

const SCOPE = "memoryOptIn"

/** Whether the key with this id runs the memory stage. */
export async function isKeyOptedIn(keyId: string | null | undefined): Promise<boolean> {
	const id = typeof keyId === "string" ? keyId.trim() : ""
	if (!id) return false
	try {
		const db = await getAdapter()
		const row = db.get<{ value?: string | null }>(
			`SELECT value FROM kv WHERE scope = ? AND key = ?`,
			[SCOPE, id],
		)
		return row?.value === "1"
	} catch {
		// An unreadable flag means "not opted in": the safe direction, because the
		// failure mode of guessing the other way is memory nobody asked for.
		return false
	}
}

/** Turn the stage on or off for one key. */
export async function setKeyOptIn(keyId: string, optedIn: boolean): Promise<void> {
	const id = typeof keyId === "string" ? keyId.trim() : ""
	if (!id) throw new Error("keyId is required")
	const db = await getAdapter()
	if (!optedIn) {
		db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id])
		return
	}
	db.run(
		`INSERT INTO kv(scope, key, value) VALUES(?, ?, '1')
		 ON CONFLICT(scope, key) DO UPDATE SET value = '1'`,
		[SCOPE, id],
	)
}

/** Every key id that opted in, for the admin listing. */
export async function listOptedInKeys(): Promise<string[]> {
	try {
		const db = await getAdapter()
		const rows = db.all<{ key: string }>(`SELECT key FROM kv WHERE scope = ?`, [SCOPE])
		return rows.map((row) => row.key)
	} catch {
		return []
	}
}

/** Resolve an API key's id from the secret, so the chat path can check the flag. */
export async function keyIdOfSecret(key: string): Promise<string | null> {
	const raw = typeof key === "string" ? key.trim() : ""
	if (!raw) return null
	try {
		const db = await getAdapter()
		const row = db.get<{ id?: string | null }>(`SELECT id FROM apiKeys WHERE key = ?`, [raw])
		return row?.id ?? null
	} catch {
		return null
	}
}
