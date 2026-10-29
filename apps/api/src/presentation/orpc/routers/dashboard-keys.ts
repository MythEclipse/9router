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

import { creatorNameFor, DASHBOARD_CREATOR, visibleApiKeys } from "@9router/auth/keyCreator"
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import type {
	ApiKeyCaller,
	ApiKeyView,
} from "../../../application/api-keys/manage-api-keys-dashboard.ts"
import { callerFromSession } from "../../caller-from-session.ts"
import { authed, type SessionClaims } from "../base.ts"

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
 * The caller, derived from the session.
 *
 * This used to be `passwordSessionCaller()` — `{ role: "admin", permissions: null }`
 * for every request — on the reasoning that "this transport authenticates with
 * better-auth, so every caller here is a password session". That held only while the
 * dashboard was not a caller. Once it is, the constant clears `mayCreateSubKey` for a
 * key session and defeats the clamping in `permissionsForSubKey`; see
 * `presentation/caller-from-session.ts` for the measured difference.
 *
 * `authed` has already refused a null session, so the throw here is unreachable by
 * construction — it exists so the type does not have to be widened to keep it true.
 */
function requireCaller(session: SessionClaims | null): ApiKeyCaller {
	const caller = callerFromSession(session)
	if (!caller)
		throw new ORPCError("UNAUTHORIZED", { status: 401, message: "Authentication required" })
	return caller
}

/** The rows the dashboard shows, with the creator key replaced by its name. */
function presentedKeys(keys: readonly ApiKeyView[], session: SessionClaims | null) {
	return visibleApiKeys([...keys], session).map((key) => ({
		...key,
		// A raw creator key is a secret and never leaves the server; the client only
		// needs a label for who made this row.
		createdBy: key.createdBy === DASHBOARD_CREATOR ? DASHBOARD_CREATOR : "",
		createdByName: creatorNameFor({ createdBy: key.createdBy, keys: [...keys] }),
	}))
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
	list: authed.handler(async ({ context }) => {
		const keys = await context.useCases.dashboardKeys.list()
		return presentedKeys(keys, context.session)
	}),

	create: authed.input(CreateKeyInput).handler(async ({ input, context }) => {
		const created = await context.useCases.dashboardKeys.create(input, requireCaller(context.session))
		/*
		 * `key` stays the view and `secret` sits beside it, rather than being spread on
		 * top: spreading `{...created.key, secret}` left `key` naming a string in the
		 * reply while the view's own `key` field held the same secret under the same
		 * name, so the type said one thing and `key.name` failed to compile. The
		 * secret is in this reply and nowhere else; nothing re-reads it.
		 */
		const keys = await context.useCases.dashboardKeys.list()
		return {
			key: created.key,
			secret: created.secret,
			createdBy: "",
			createdByName: creatorNameFor({ createdBy: created.key.createdBy, keys: [...keys] }),
		}
	}),

	bulkEdit: authed
		.input(BulkEditInput)
		.handler(async ({ input, context }) =>
			context.useCases.bulkEditKeys.update(input, requireCaller(context.session)),
		),

	get: authed
		.input(KeyIdInput)
		.handler(async ({ input, context }) =>
			context.useCases.singleKey.get(input.id, requireCaller(context.session)),
		),

	update: authed.input(KeyIdInput.merge(UpdateKeyInput)).handler(async ({ input, context }) => {
		const { id, ...body } = input
		return context.useCases.singleKey.update(id, body, requireCaller(context.session))
	}),

	remove: authed.input(KeyIdInput).handler(async ({ input, context }) => {
		await context.useCases.singleKey.remove(input.id, requireCaller(context.session))
		return { message: "Key deleted successfully" }
	}),
}
