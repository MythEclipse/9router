/**
 * Manage the dashboard's API keys.
 *
 * Two rules live here rather than in the route: names are unique, and a session
 * authenticated by a key may only mint keys inside its own scope. Both are
 * decisions about the whole key table, so they belong with the port that reads
 * it, not with the HTTP verb that triggered them.
 *
 * Creation returns the secret once. Nothing in this module ever reads it back —
 * after this call the plaintext exists only in the response the caller shows.
 */

import { conflict, forbidden, invalid } from "../../domain/errors.ts"
import {
	type CreatorScope,
	type KeyPermissions,
	mayCreateSubKey,
	permissionsForSubKey,
	scopeSubKey,
	validateEndpointKinds,
} from "../../domain/sub-key-scope.ts"

/** One row of the dashboard's key table, secrets excluded. */
export interface ApiKeyView {
	readonly id: string
	readonly name: string
	readonly key: string
	readonly machineId: string
	readonly isActive: boolean
	readonly tokenLimit: number
	readonly usedTokens: number
	readonly resetInterval: string
	readonly lastResetAt: string | null
	readonly allowedModels: string
	readonly allowedEndpoints: readonly string[]
	readonly rpmLimit: number
	readonly tpmLimit: number
	readonly dailyCostLimit: number
	readonly requestLimit: number
	readonly limitKind: string
	readonly permissions: KeyPermissions | null
	readonly createdBy: string
	readonly createdAt?: string
	readonly expiresAt?: string | null
	readonly systemPrompt?: string
}

export interface CreateApiKeyInput {
	readonly name: unknown
	readonly tokenLimit?: unknown
	readonly resetInterval?: string | null
	readonly allowedModels?: string | null
	readonly allowedEndpoints?: readonly string[] | null
	readonly rpmLimit?: unknown
	readonly tpmLimit?: unknown
	readonly dailyCostLimit?: unknown
	readonly requestLimit?: unknown
	readonly limitKind?: string | null
	readonly expiresAt?: string | null
	readonly systemPrompt?: string | null
	readonly permissions?: KeyPermissions | null
}

/** The caller, as far as key scoping is concerned. */
export interface ApiKeyCaller {
	readonly role: string | null
	/** Named in the audit entry; a password user has none. */
	readonly keyName?: string | null
	readonly keyId?: string | null
	readonly apiKey?: string | null
	readonly scope: CreatorScope
	readonly permissions: KeyPermissions | null
}

export interface ApiKeyManagementPort {
	list(): Promise<readonly ApiKeyView[]>
	/**
	 * Creates the key. `secret` is the value stored in the row's `key` field; the
	 * store keeps no separate copy and cannot reveal it a second time.
	 */
	create(
		name: string,
		scope: {
			readonly tokenLimit: number
			readonly resetInterval: string
			readonly allowedModels: string
			readonly allowedEndpoints: readonly string[]
			readonly rpmLimit: number
			readonly tpmLimit: number
			readonly dailyCostLimit: number
			readonly requestLimit: number
			readonly limitKind: string
			readonly expiresAt: string | null
			readonly systemPrompt: string
			readonly permissions: KeyPermissions | null
			readonly createdBy: string | null
		},
	): Promise<{ readonly key: ApiKeyView; readonly secret: string }>
	/** Deletes by id; returns how many rows went. */
	removeMany(ids: readonly string[]): Promise<number>
	remove(id: string): Promise<boolean>
}

export interface ApiKeyAuditPort {
	recordKeyCreated(event: {
		readonly actor: string
		readonly keyName: string
		readonly permissions: KeyPermissions | null
	}): Promise<void>
}

const DEFAULT_PERMISSIONS: KeyPermissions = { viewUsage: true, manageApiKeys: false }

const VALID_LIMIT_KINDS = ["tokens", "cost", "requests"] as const

function asNumberOrZero(value: unknown): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function asLimitKind(value: unknown): string {
	return VALID_LIMIT_KINDS.includes(value as (typeof VALID_LIMIT_KINDS)[number])
		? (value as string)
		: "tokens"
}

export function makeManageApiKeys(deps: {
	readonly keys: ApiKeyManagementPort
	readonly audit: ApiKeyAuditPort
	readonly matchesAllowedModels: (patterns: readonly string[], model: string) => boolean
	/** The endpoint kinds this deployment serves; owned by `packages/db`. */
	readonly endpointKinds: readonly string[]
}) {
	return {
		async list(): Promise<readonly ApiKeyView[]> {
			return deps.keys.list()
		},

		async create(
			input: CreateApiKeyInput,
			caller: ApiKeyCaller,
		): Promise<{ readonly key: ApiKeyView; readonly secret: string }> {
			if (!mayCreateSubKey(caller.role, caller.permissions)) {
				throw forbidden("Permission denied: manageApiKeys")
			}

			const name = typeof input.name === "string" ? input.name.trim() : ""
			if (name.length === 0) throw invalid("Name is required")

			// Uniqueness is checked against every key, not just the ones this caller
			// can see: two keys with one name would make the audit trail ambiguous and
			// the dashboard's name-based lookups pick an arbitrary one.
			const existing = await deps.keys.list()
			if (existing.some((key) => key.name === name)) {
				throw conflict(`A key named "${name}" already exists. Use a different name.`)
			}

			// Refused before anything is written, and before the caps are checked, because
			// a request naming an endpoint that does not exist is malformed whatever its
			// limits are.
			const endpoints = validateEndpointKinds(input.allowedEndpoints, deps.endpointKinds)
			if (endpoints.ok === false) throw invalid(endpoints.error)

			const permissions = permissionsForSubKey(caller.role, input.permissions, DEFAULT_PERMISSIONS)

			const scoped = scopeSubKey(
				{
					tokenLimit: input.tokenLimit,
					dailyCostLimit: input.dailyCostLimit,
					allowedModels: input.allowedModels,
					allowedEndpoints: endpoints.value,
				},
				caller.scope,
				deps.matchesAllowedModels,
			)
			if (scoped.ok === false) {
				throw invalid(
					scoped.error.field === "tokenLimit"
						? `Token limit cannot exceed your maximum (${scoped.error.creatorMax}).`
						: `Daily cost limit cannot exceed your maximum ($${scoped.error.creatorMax}).`,
				)
			}

			const created = await deps.keys.create(name, {
				tokenLimit: scoped.value.tokenLimit,
				resetInterval: input.resetInterval || "never",
				allowedModels: scoped.value.allowedModels,
				allowedEndpoints: scoped.value.allowedEndpoints,
				rpmLimit: asNumberOrZero(input.rpmLimit),
				tpmLimit: asNumberOrZero(input.tpmLimit),
				dailyCostLimit: scoped.value.dailyCostLimit,
				requestLimit: asNumberOrZero(input.requestLimit),
				limitKind: asLimitKind(input.limitKind),
				expiresAt: input.expiresAt || null,
				systemPrompt: input.systemPrompt || "",
				permissions,
				createdBy: caller.role === "apikey" ? (caller.apiKey ?? null) : null,
			})

			// A credential appearing is a security event. Best effort: a key that was
			// minted but not logged is better than a caller told their create failed
			// while the key exists and works.
			await deps.audit
				.recordKeyCreated({
					actor:
						caller.role === "apikey" ? `API key "${caller.keyName || caller.keyId}"` : "Password user",
					keyName: name,
					permissions,
				})
				.catch(() => undefined)

			return created
		},

		/** Refuses an empty selection: "delete nothing" reporting success hides a bug. */
		async removeMany(ids: readonly string[]): Promise<number> {
			if (ids.length === 0) throw invalid("No keys selected")
			return deps.keys.removeMany(ids)
		},
	}
}
