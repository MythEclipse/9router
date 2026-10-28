/**
 * Bulk edit of API keys, replacing the loop that lived inside the route.
 *
 * The route owned the whitelist, the 500-key cap, the fetch-then-filter dance
 * and the per-key try/catch. All four are decisions, so all four are here; the
 * route keeps the request and the reply.
 */

import {
	type BulkOutcome,
	type BulkPatch,
	mayBulkEdit,
	parseBulkPatch,
	parseBulkSelection,
	splitSelection,
} from "../../domain/bulk-key-edit.ts"
import { forbidden, invalid } from "../../domain/errors.ts"
import type { ApiKeyView } from "./manage-api-keys-dashboard.ts"

export interface BulkEditPort {
	listIds(): Promise<readonly string[]>
	update(id: string, patch: BulkPatch): Promise<boolean>
}

export interface BulkEditAuditPort {
	recordBulkUpdate(event: {
		readonly updatedCount: number
		readonly fields: readonly string[]
	}): Promise<void>
}

export function makeBulkEditApiKeys(deps: {
	readonly keys: BulkEditPort
	readonly audit: BulkEditAuditPort
}) {
	return {
		async update(
			input: { readonly ids: unknown; readonly patch: unknown },
			caller: { readonly role: string | null },
		): Promise<BulkOutcome> {
			if (!mayBulkEdit(caller.role)) {
				throw forbidden("Only a password sign-in can bulk edit keys")
			}

			const selection = parseBulkSelection(input.ids)
			if (selection.ok === false) throw invalid(selection.error)

			const parsed = parseBulkPatch(input.patch)
			if (parsed.ok === false) throw invalid(parsed.error)

			const existing = new Set(await deps.keys.listIds())
			const { targets, missing: unseen } = splitSelection(selection.ids, existing)
			const missing = [...unseen]

			const updated: string[] = []
			const failed: { id: string; error: string }[] = []
			for (const id of targets) {
				try {
					if (await deps.keys.update(id, parsed.patch)) updated.push(id)
					else missing.push(id)
				} catch (error) {
					failed.push({
						id,
						error: error instanceof Error ? error.message : "update failed",
					})
				}
			}

			if (updated.length > 0) {
				await deps.audit
					.recordBulkUpdate({
						updatedCount: updated.length,
						fields: Object.keys(parsed.patch),
					})
					.catch(() => undefined)
			}

			return { updated, missing, failed }
		},
	}
}

/** Re-exported so the route does not need a second import for the row type. */
export type { ApiKeyView }
