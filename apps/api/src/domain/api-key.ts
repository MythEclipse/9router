/**
 * Domain port for API-key persistence.
 *
 * Deliberately tiny and framework-free: no Drizzle, no better-auth, no Hono.
 * The Drizzle implementation lives in infrastructure/; use-cases receive this
 * interface through `Dependencies` and never import the database.
 */

/** A stored gateway key. Mirrors only what callers actually need. */
export interface IApiKey {
	readonly id: string
	readonly name: string
	readonly keyPrefix: string
	/** Hash of the secret; the plaintext is shown once at creation and never stored. */
	readonly keyHash: string
	readonly createdAt: Date
	readonly lastUsedAt: Date | null
	readonly revokedAt: Date | null
}

export interface IApiKeyRepository {
	findById(id: string): Promise<IApiKey | null>
	findByPrefix(prefix: string): Promise<readonly IApiKey[]>
	list(): Promise<readonly IApiKey[]>
	insert(key: IApiKey): Promise<IApiKey>
	touchLastUsed(id: string, at: Date): Promise<void>
	revoke(id: string, at: Date): Promise<void>
}
