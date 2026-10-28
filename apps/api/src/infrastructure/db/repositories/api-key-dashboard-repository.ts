/**
 * Dashboard API-key adapters.
 *
 * Both use-cases work against narrow ports; this is the only place that knows
 * the legacy `localDb` free functions behind them. Kept in one file because the
 * two ports read the same table and a split would let one drift.
 */

import { matchesAllowedModels } from "@9router/db/repos/allowedModels"
import { recordSecurityEvent } from "@9router/db/repos/securityLogRepo"
import { API_KEY_ENDPOINT_KINDS } from "@9router/db/shared/keyEndpoints"
import type { BulkEditPort } from "../../../application/api-keys/bulk-edit-api-keys.ts"
import type {
	ApiKeyManagementPort,
	ApiKeyView,
} from "../../../application/api-keys/manage-api-keys-dashboard.ts"
import type {
	SingleKeyAuditPort,
	SingleKeyPort,
} from "../../../application/api-keys/manage-single-key.ts"

function asView(row: Record<string, unknown>): ApiKeyView {
	return row as unknown as ApiKeyView
}

/**
 * The three legacy helpers this adapter needs, supplied by the host process.
 *
 * `apps/web` owns `localDb` and the machine id; `apps/api` cannot import them
 * through `@/` (that alias is the web app's), so the host passes them in the
 * same way it already passes `comboPresets`.
 */
export interface ApiKeyStore {
	list(): Promise<readonly Record<string, unknown>[]>
	findById(id: string): Promise<Record<string, unknown> | null>
	create(name: string, machineId: string, scope: Record<string, unknown>): Promise<unknown>
	update(id: string, patch: Record<string, unknown>): Promise<unknown>
	remove(id: string): Promise<boolean>
	consistentMachineId(): Promise<string>
}

export function makeApiKeyManagementPort(store: ApiKeyStore): ApiKeyManagementPort {
	return {
		async list() {
			const rows = await store.list()
			return rows.map(asView)
		},

		async create(name, scope) {
			// The store returns the row it wrote, and its `key` field is the secret —
			// there is no wrapper object and no second reveal. Reading `created.key.key`
			// here is what an earlier version got wrong, which produced a 201 with an
			// empty body.
			const written = (await store.create(name, await store.consistentMachineId(), {
				tokenLimit: scope.tokenLimit,
				resetInterval: scope.resetInterval,
				allowedModels: scope.allowedModels,
				allowedEndpoints: scope.allowedEndpoints,
				rpmLimit: scope.rpmLimit,
				tpmLimit: scope.tpmLimit,
				dailyCostLimit: scope.dailyCostLimit,
				requestLimit: scope.requestLimit,
				limitKind: scope.limitKind,
				expiresAt: scope.expiresAt,
				systemPrompt: scope.systemPrompt,
				permissions: scope.permissions,
				createdBy: scope.createdBy,
			})) as unknown as ApiKeyView
			return { key: written, secret: written.key }
		},

		async removeMany(ids) {
			let removed = 0
			for (const id of ids) {
				if (await store.remove(id)) removed += 1
			}
			return removed
		},

		async remove(id) {
			return store.remove(id)
		},
	}
}

export function makeBulkEditPort(store: ApiKeyStore): BulkEditPort {
	return {
		async listIds() {
			const rows = await store.list()
			return rows.map((row) => String(row.id))
		},
		async update(id, patch) {
			return Boolean(await store.update(id, patch))
		},
	}
}

export function makeApiKeyAuditPort() {
	return {
		async recordKeyCreated(event: {
			readonly actor: string
			readonly keyName: string
			readonly permissions: unknown
		}) {
			await recordSecurityEvent({
				type: "key_created",
				severity: "info",
				actor: event.actor,
				method: "POST",
				path: "/api/keys",
				detail: `Created API key "${event.keyName}" - permissions: ${JSON.stringify(event.permissions ?? {})}`,
			})
		},
		async recordBulkUpdate(event: {
			readonly updatedCount: number
			readonly fields: readonly string[]
		}) {
			await recordSecurityEvent({
				type: "keys_bulk_update",
				severity: "info",
				actor: "Dashboard password user",
				method: "PATCH",
				path: "/api/keys/bulk",
				status: 200,
				detail: `${event.updatedCount} key(s) updated in bulk: ${event.fields.join(", ")}`,
			})
		},
	}
}

/** Single-key operations reuse the same store; no second adapter is needed. */
export function makeSingleKeyPort(store: ApiKeyStore): SingleKeyPort {
	return {
		async findById(id) {
			const row = await store.findById(id)
			return row === null ? null : (row as unknown as ApiKeyView)
		},
		async list() {
			return (await store.list()).map((row) => row as unknown as ApiKeyView)
		},
		async update(id, patch) {
			const row = await store.update(id, patch)
			return row === null ? null : (row as unknown as ApiKeyView)
		},
		remove: (id) => store.remove(id),
	}
}

/** Security events the dashboard key routes record. */
export function makeSingleKeyAuditPort(): SingleKeyAuditPort {
	return {
		async recordKeyDeleted(event) {
			await recordSecurityEvent({
				type: "key_deleted",
				severity: "warn",
				actor: event.actor,
				method: "DELETE",
				path: "/api/keys",
				detail: `Deleted API key "${event.keyName}"`,
			})
		},
	}
}

export { API_KEY_ENDPOINT_KINDS, matchesAllowedModels }
