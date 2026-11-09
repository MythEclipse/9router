/**
 * Provider-connection writes.
 *
 * Extracted verbatim from connectionsRepo.ts.
 */

import { v4 as uuidv4 } from "uuid"
import { getAdapter } from "../driver.ts"
import type { ResolvedDbAdapter } from "../types.ts"

import {
	deriveConnectionName,
	OPTIONAL_FIELDS,
	reorderInTx,
	resetHealthStateOnActivation,
	rowToConn,
	upsert,
} from "./connectionsHelpers.ts"
import type {
	CreateConnectionInput,
	ProviderConnectionRecord,
	ProviderConnectionRow,
} from "./connectionsTypes.ts"

export async function createProviderConnection(
	data: CreateConnectionInput,
): Promise<ProviderConnectionRecord | null> {
	const db = await getAdapter()
	const now = new Date().toISOString()
	// Annotated because the transaction body assigns it inside a callback: without
	// this the compiler only sees the `undefined` initialiser at the return.
	let result: ProviderConnectionRecord | null = null

	db.transaction(() => {
		// apikey connections are deduped by name and need only the current max
		// priority, so query for those directly instead of loading the whole pool
		// (O(pool) per key - the other half of the import cost in #4311). The oauth
		// branch below still scans, because its identity rules compare fields
		// inside providerSpecificData and have no single-column equivalent.
		const isApikey = data.authType === "apikey" && !!data.name
		const all = isApikey
			? db
					.all(`SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`, [
						data.provider,
						"apikey",
						data.name,
					])
					.map((row) => rowToConn(row as ProviderConnectionRow))
			: db
					.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider])
					.map((row) => rowToConn(row as ProviderConnectionRow))
		const poolSize = isApikey
			? (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [
					data.provider,
				])?.n ?? all.length)
			: all.length

		let existing = null
		if (data.authType === "oauth" && data.email) {
			const incomingUsername = data.providerSpecificData?.username
			const incomingWs = data.providerSpecificData?.chatgptAccountId
			existing = all.find((c) => {
				if (c.authType !== "oauth" || c.email !== data.email) return false

				// Codex/OpenAI can issue multiple OAuth grants for the same email.
				// Refresh tokens are rotated single-use; collapsing a new login onto an
				// existing bare-email row overwrites the first account's token pair and
				// makes it look "invalid" after adding a second account. Only update an
				// existing Codex row when both rows expose the same ChatGPT account ID.
				if (data.provider === "codex") {
					const existingWs = c.providerSpecificData?.chatgptAccountId
					return !!incomingWs && !!existingWs && incomingWs === existingWs
				}

				// Workspace providers use workspace ID when both sides have it
				const existingWs = c.providerSpecificData?.chatgptAccountId
				if (incomingWs && existingWs) return incomingWs === existingWs
				if (incomingWs && !existingWs) return false
				if (!incomingWs && existingWs) return false
				// Non-workspace providers: match on (email + username) so cross-IdP
				// accounts don't overwrite each other. Require username on both sides
				// - if only one side has it, treat as a distinct identity rather than
				// collapsing onto the bare-email fallback (which would re-introduce
				// the cross-IdP overwrite).
				const existingUsername = c.providerSpecificData?.username
				if (incomingUsername && existingUsername) {
					return incomingUsername === existingUsername
				}
				if (incomingUsername || existingUsername) return false
				return true
			})
		} else if (data.authType === "apikey" && data.name) {
			existing = all.find((c) => c.authType === "apikey" && c.name === data.name)
		}
		// access_token: never dedup - user manages duplicates manually

		if (existing) {
			// Name collision on an apikey connection used to silently replace the
			// stored apiKey, so a script that reused names ("Key 1", "Key 2", …)
			// destroyed existing pool entries with no 409 and no warning. Callers that
			// genuinely mean "update this one" pass allowOverwrite; everyone else gets
			// a typed error naming the row that would have been replaced. #4311
			if (data.allowOverwrite === false) {
				throw Object.assign(
					new Error(
						`A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
							`Pass allowOverwrite: true to replace it.`,
					),
					{
						code: "PROVIDER_NAME_CONFLICT",
						existingId: existing.id,
						existingName: existing.name,
					},
				)
			}
			const normalized = resetHealthStateOnActivation(existing, data)
			const merged = { ...existing, ...normalized, updatedAt: now }
			upsert(db, merged)
			result = merged
			return
		}

		let connectionName: string | null = data.name || null
		if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
			connectionName = deriveConnectionName(data, String(data.email || `Account ${poolSize + 1}`))
		}
		let connectionPriority = data.priority
		if (!connectionPriority) {
			// MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
			// apikey path no longer has the whole pool in memory, and the aggregate
			// is served by the index instead of a row scan. #4311
			const maxRow = db.get<{ m: number | null }>(
				`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`,
				[data.provider],
			)
			connectionPriority = (maxRow?.m || 0) + 1
		}

		const conn: ProviderConnectionRecord = {
			id: uuidv4(),
			provider: String(data.provider),
			authType: data.authType || "oauth",
			name: connectionName,
			email: data.email ?? null,
			priority: connectionPriority,
			isActive: data.isActive !== undefined ? data.isActive : true,
			createdAt: now,
			updatedAt: now,
		}
		for (const f of OPTIONAL_FIELDS) {
			if (data[f] !== undefined && data[f] !== null) conn[f] = data[f]
		}
		if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
			conn.providerSpecificData = data.providerSpecificData
		}
		if (data.email !== undefined) conn.email = data.email

		upsert(db, conn)
		// No reorderInTx here. `conn.priority` is already MAX(priority)+1, so the
		// row sorts last and the resulting order is what reorderInTx would have
		// produced anyway. The rewrite cost ~2N statements per insert - O(pool) -
		// which made a 5k-key import O(n*m): ~25M statements at a 5k pool, and it
		// serialized every parallel writer on the same transaction. #4311
		result = conn
	})

	return result
}

// Critical: OAuth refresh token race - atomic merge inside transaction
export async function updateProviderConnection(
	id: string,
	data: Partial<ProviderConnectionRecord> & Record<string, unknown>,
): Promise<ProviderConnectionRecord | null> {
	const db = await getAdapter()
	let result: ProviderConnectionRecord | null = null
	db.transaction(() => {
		const row = db.get<ProviderConnectionRow>(`SELECT * FROM providerConnections WHERE id = ?`, [id])
		if (!row) {
			result = null
			return
		}
		const existing = rowToConn(row)
		const normalized = resetHealthStateOnActivation(existing, data)
		const merged: ProviderConnectionRecord = {
			...existing,
			...normalized,
			updatedAt: new Date().toISOString(),
		}
		upsert(db, merged)
		if (data.priority !== undefined) reorderInTx(db, existing.provider)
		result = merged
	})
	return result
}
