/**
 * Drizzle-backed implementation of the API-key port.
 *
 * The only file that knows both the domain shape and the SQL shape. Everything
 * above it depends on `IApiKeyRepository`, so the storage engine can change
 * without touching a use-case.
 */
import { eq } from "drizzle-orm"
import type { IApiKey, IApiKeyRepository } from "../../../domain/api-key.ts"
import type { Db } from "../client.ts"
import { apiKeys } from "../schema.ts"

type ApiKeyRow = typeof apiKeys.$inferSelect

function toDomain(row: ApiKeyRow): IApiKey {
	return {
		id: row.id,
		name: row.name,
		keyPrefix: row.keyPrefix,
		keyHash: row.keyHash,
		createdAt: row.createdAt,
		lastUsedAt: row.lastUsedAt ?? null,
		revokedAt: row.revokedAt ?? null,
	}
}

export function createApiKeyRepository(db: Db): IApiKeyRepository {
	return {
		async findById(id) {
			const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1)
			return row ? toDomain(row) : null
		},

		async findByPrefix(prefix) {
			const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix))
			return rows.map(toDomain)
		},

		async list() {
			const rows = await db.select().from(apiKeys)
			return rows.map(toDomain)
		},

		async insert(key) {
			await db.insert(apiKeys).values({
				id: key.id,
				name: key.name,
				keyPrefix: key.keyPrefix,
				keyHash: key.keyHash,
				createdAt: key.createdAt,
				lastUsedAt: key.lastUsedAt,
				revokedAt: key.revokedAt,
			})
			return key
		},

		async touchLastUsed(id, at) {
			await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id))
		},

		async revoke(id, at) {
			await db.update(apiKeys).set({ revokedAt: at }).where(eq(apiKeys.id, id))
		},
	}
}
