/**
 * The dashboard's key-table procedures.
 *
 * Validate, delegate, return. Uniqueness, the creator's caps, the bulk
 * whitelist and the 500-key limit all live in `domain/`, so the REST route and
 * this router cannot disagree about what a key may be given.
 *
 * The caller's scope is built here from the authenticated context rather than
 * accepted from the request body: a client that could state its own caps would
 * be able to mint past them.
 */
import { z } from "zod"

import type { ApiKeyCaller } from "../../../application/api-keys/manage-api-keys-dashboard.ts"
import { authed } from "../base.ts"

/**
 * Both flags are required. A partial map would let a caller send `{}` and get a
 * key whose permissions were decided by whichever default happened to apply.
 */
const PermissionsInput = z.object({
	viewUsage: z.boolean(),
	manageApiKeys: z.boolean(),
})

const CreateKeyInput = z.object({
	name: z.unknown(),
	tokenLimit: z.unknown().optional(),
	resetInterval: z.string().nullable().optional(),
	allowedModels: z.string().nullable().optional(),
	allowedEndpoints: z.array(z.string()).nullable().optional(),
	rpmLimit: z.unknown().optional(),
	tpmLimit: z.unknown().optional(),
	dailyCostLimit: z.unknown().optional(),
	requestLimit: z.unknown().optional(),
	limitKind: z.string().nullable().optional(),
	expiresAt: z.string().nullable().optional(),
	systemPrompt: z.string().nullable().optional(),
	permissions: PermissionsInput.nullable().optional(),
})

const BulkEditInput = z.object({
	ids: z.unknown(),
	patch: z.unknown(),
})

/**
 * The caller, as the key rules need to see it.
 *
 * This transport authenticates with better-auth, so every caller here is a
 * password session: there is no API-key identity on an oRPC request and
 * therefore no creator caps to enforce. The caps matter on the REST route,
 * where a *key* can be the caller — that path passes a real scope.
 *
 * Representing that as an unrestricted caller rather than inventing a role is
 * the honest version: a password session genuinely has no limit, and the
 * scoping rules correctly do nothing. The escalation gate (`mayCreateSubKey`)
 * still runs, and still lets a password session through.
 */
function passwordSessionCaller(): ApiKeyCaller {
	return {
		role: "admin",
		apiKey: null,
		keyName: null,
		keyId: null,
		scope: {},
		permissions: null,
	}
}

/** Everything the PUT body may carry; the rules decide what takes effect. */
const UpdateKeyInput = z.object({
	name: z.unknown().optional(),
	isActive: z.unknown().optional(),
	usedTokens: z.unknown().optional(),
	lastResetAt: z.unknown().optional(),
	systemPrompt: z.unknown().optional(),
	resetInterval: z.unknown().optional(),
	rpmLimit: z.unknown().optional(),
	tpmLimit: z.unknown().optional(),
	requestLimit: z.unknown().optional(),
	limitKind: z.unknown().optional(),
	expiresAt: z.unknown().optional(),
	tokenLimit: z.unknown().optional(),
	dailyCostLimit: z.unknown().optional(),
	allowedModels: z.unknown().optional(),
	allowedEndpoints: z.unknown().optional(),
	permissions: PermissionsInput.optional(),
})

const KeyIdInput = z.object({ id: z.string().min(1) })

export const dashboardKeysRouter = {
	list: authed.handler(async ({ context }) => context.useCases.dashboardKeys.list()),

	create: authed.input(CreateKeyInput).handler(async ({ input, context }) => {
		const created = await context.useCases.dashboardKeys.create(input, passwordSessionCaller())
		// The secret is in this reply and nowhere else; nothing re-reads it.
		return { ...created.key, secret: created.secret, createdBy: "" }
	}),

	bulkEdit: authed
		.input(BulkEditInput)
		.handler(async ({ input, context }) =>
			context.useCases.bulkEditKeys.update(input, passwordSessionCaller()),
		),

	get: authed
		.input(KeyIdInput)
		.handler(async ({ input, context }) =>
			context.useCases.singleKey.get(input.id, passwordSessionCaller()),
		),

	update: authed.input(KeyIdInput.merge(UpdateKeyInput)).handler(async ({ input, context }) => {
		const { id, ...body } = input
		return context.useCases.singleKey.update(id, body, passwordSessionCaller())
	}),

	remove: authed.input(KeyIdInput).handler(async ({ input, context }) => {
		await context.useCases.singleKey.remove(input.id, passwordSessionCaller())
		return { message: "Key deleted successfully" }
	}),
}
