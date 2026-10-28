/**
 * One key at a time: read, edit, delete.
 *
 * The ownership verdict and the patch are both domain functions; this use-case is
 * the point where they meet a table. Keeping the two separate is what makes the
 * PUT and DELETE handlers agree — they previously wrote the same ownership
 * checks out twice, in a different order.
 */

import { conflict, forbidden, invalid, notFound } from "../../domain/errors.ts"
import { mayReadKey, mayWriteKey, type OwnershipCaller } from "../../domain/key-ownership.ts"
import { buildKeyUpdate } from "../../domain/key-update.ts"
import type { ApiKeyView } from "./manage-api-keys-dashboard.ts"

export interface SingleKeyPort {
	findById(id: string): Promise<ApiKeyView | null>
	list(): Promise<readonly ApiKeyView[]>
	update(id: string, patch: Record<string, unknown>): Promise<ApiKeyView | null>
	remove(id: string): Promise<boolean>
}

export interface SingleKeyAuditPort {
	recordKeyDeleted(event: { readonly actor: string; readonly keyName: string }): Promise<void>
}

export interface SingleKeyCaller extends OwnershipCaller {
	readonly role: string | null
	readonly keyName?: string | null
	readonly keyId?: string | null
	readonly apiKey?: string | null
	readonly permissions?: { readonly manageApiKeys?: boolean } | null
	readonly scope: {
		readonly tokenLimit?: number | null
		readonly dailyCostLimit?: number | null
		readonly allowedModels?: string | null
		readonly allowedEndpoints?: readonly string[] | null
	}
}

export function makeManageSingleKey(deps: {
	readonly keys: SingleKeyPort
	readonly audit: SingleKeyAuditPort
	readonly endpointKinds: readonly string[]
	readonly matchesAllowedModels: (patterns: readonly string[], model: string) => boolean
	readonly defaultPermissions: unknown
}) {
	const actorFor = (caller: SingleKeyCaller) =>
		caller.role === "apikey" ? `API key "${caller.keyName || caller.keyId}"` : "Password user"

	/** Turn a rejected verdict into the error type the caller asked for. */
	const refuse = (verdict: { reason: "forbidden" | "not_found"; message: string }) => {
		throw verdict.reason === "not_found" ? notFound("Key") : forbidden(verdict.message)
	}

	return {
		async get(id: string, caller: SingleKeyCaller): Promise<ApiKeyView> {
			// Read the row once: the verdict and the reply must describe the same row,
			// and a second read could see a concurrent delete.
			const row = await deps.keys.findById(id)
			const verdict = mayReadKey(row, caller)
			if (verdict.allowed === false) refuse(verdict)
			if (row === null) throw notFound("Key")
			return row
		},

		async update(
			id: string,
			body: Record<string, unknown>,
			caller: SingleKeyCaller,
		): Promise<ApiKeyView> {
			const existing = await deps.keys.findById(id)
			const verdict = mayWriteKey(existing, caller, "edit")
			if (verdict.allowed === false) refuse(verdict)

			const built = buildKeyUpdate({
				body,
				id,
				otherNames: (await deps.keys.list()).map((key) => ({
					id: key.id,
					name: key.name,
				})),
				creatorScope: caller.role === "apikey" ? caller.scope : null,
				endpointKinds: deps.endpointKinds,
				matchesAllowedModels: deps.matchesAllowedModels,
				defaultPermissions: deps.defaultPermissions,
			})
			if (built.ok === false) {
				// A clashing name is a conflict; every other refusal is a bad value. The
				// original answered 409 for the name and 400 for the rest, and the
				// dashboard distinguishes the two.
				throw built.error.field === "name" && built.error.message.includes("already exists")
					? conflict(built.error.message)
					: invalid(built.error.message)
			}

			const updated = await deps.keys.update(id, built.patch)
			if (updated === null) throw notFound("Key")
			return updated
		},

		async remove(id: string, caller: SingleKeyCaller): Promise<void> {
			const existing = await deps.keys.findById(id)
			const verdict = mayWriteKey(existing, caller, "delete")
			if (verdict.allowed === false) refuse(verdict)

			const deleted = await deps.keys.remove(id)
			if (!deleted) throw notFound("Key")

			// A credential disappearing is worth a record, but a delete that already
			// happened must not be reported as failed because the log write failed.
			await deps.audit
				.recordKeyDeleted({
					actor: actorFor(caller),
					keyName: existing?.name || id,
				})
				.catch(() => undefined)
		},
	}
}
