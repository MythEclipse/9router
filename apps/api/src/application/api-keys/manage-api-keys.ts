/**
 * List and revoke API keys.
 *
 * Both are pure reads/writes over the injected port; revoking is idempotent so
 * a retried request cannot fail after the first success.
 */

import type { IApiKey } from "../../domain/api-key.ts"
import { notFound } from "../../domain/errors.ts"
import type { Dependencies } from "../dependencies.ts"

export function makeListApiKeys(deps: Dependencies) {
	return async (): Promise<readonly IApiKey[]> => deps.apiKeys.list()
}

export interface RevokeApiKeyInput {
	readonly id: string
}

export function makeRevokeApiKey(deps: Dependencies) {
	return async (input: RevokeApiKeyInput): Promise<IApiKey> => {
		const existing = await deps.apiKeys.findById(input.id)
		if (!existing) throw notFound("API key")

		const now = deps.now()
		if (existing.revokedAt) return existing

		await deps.apiKeys.revoke(input.id, now)
		await deps.activity.record({
			action: "apiKey.revoke",
			subject: input.id,
			payload: { name: existing.name },
			at: now,
		})

		return { ...existing, revokedAt: now }
	}
}
