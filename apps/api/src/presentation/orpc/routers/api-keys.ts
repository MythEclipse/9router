/**
 * API-key procedures.
 *
 * Thin by construction: validate (schema), delegate (use-case), return. No
 * business rule and no database call lives in this file — the audit write and
 * the hash both happen inside the use-case.
 *
 * Order is fixed by oRPC 1.x: `.input()` then `.use()` then `.handler()`.
 */
import { authed } from "../base.ts"
import { CreateApiKeySchema, CreatedApiKeySchema, RevokeApiKeySchema } from "../schemas.ts"

export const apiKeysRouter = {
	list: authed.handler(async ({ context }) => {
		const keys = await context.useCases.listApiKeys()
		return keys.map(({ keyHash: _keyHash, ...view }) => view)
	}),

	create: authed
		.input(CreateApiKeySchema)
		.output(CreatedApiKeySchema)
		.handler(async ({ input, context }) => {
			const { key, secret } = await context.useCases.createApiKey(input)
			const { keyHash: _keyHash, ...view } = key
			return { key: view, secret }
		}),

	revoke: authed.input(RevokeApiKeySchema).handler(async ({ input, context }) => {
		const key = await context.useCases.revokeApiKey(input)
		const { keyHash: _keyHash, ...view } = key
		return view
	}),
}
