/**
 * Create an API key.
 *
 * Factory shape mandated by the stack: `makeX(deps) → (input) => Promise<...>`.
 * The audit entry is written here, in the same unit of work as the insert, so a
 * successful call can never be missing from the trail.
 */

import type { IApiKey } from "../../domain/api-key.ts"
import { invalid } from "../../domain/errors.ts"
import { mintApiKey } from "../api-key-secret.ts"
import type { Dependencies } from "../dependencies.ts"

export interface CreateApiKeyInput {
	readonly name: string
}

export interface CreateApiKeyResult {
	readonly key: IApiKey
	/** Returned once; the caller must show it and let it go. */
	readonly secret: string
}

export function makeCreateApiKey(deps: Dependencies) {
	return async (input: CreateApiKeyInput): Promise<CreateApiKeyResult> => {
		const name = input.name.trim()
		if (name.length === 0) throw invalid("Key name is required")
		if (name.length > 100) throw invalid("Key name must be 100 characters or fewer")

		const minted = mintApiKey()
		const now = deps.now()
		const key: IApiKey = {
			id: deps.randomId(),
			name,
			keyPrefix: minted.prefix,
			keyHash: minted.hash,
			createdAt: now,
			lastUsedAt: null,
			revokedAt: null,
		}

		const stored = await deps.apiKeys.insert(key)
		await deps.activity.record({
			action: "apiKey.create",
			subject: stored.id,
			payload: { name: stored.name },
			at: now,
		})

		return { key: stored, secret: minted.secret }
	}
}
