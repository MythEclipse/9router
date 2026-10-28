/**
 * Building the patch a `PUT /api/keys/[id]` becomes.
 *
 * The handler had eighteen `if (body.x !== undefined)` blocks, each doing its own
 * coercion, and two of them doing a different check depending on who was asking.
 * Written out, the blocks were harmless; the ordering was not — `allowedModels`
 * matched patterns one way here and another way on create, because the create
 * path also matched the provider-qualified form.
 *
 * This returns the patch or the first refusal, so the handler never has to decide
 * what a partially-applied edit means.
 */

import {
	type CreatorScope,
	clampAllowedModels,
	clampEndpoints,
	parseCreatorPatterns,
	validateEndpointKinds,
} from "./sub-key-scope.ts"

export type UpdateRefusal =
	| { readonly field: "name"; readonly message: string }
	| { readonly field: "tokenLimit"; readonly message: string }
	| { readonly field: "dailyCostLimit"; readonly message: string }
	| { readonly field: "allowedEndpoints"; readonly message: string }

export interface UpdateKeyPatch {
	readonly [field: string]: unknown
}

export type UpdateResult =
	| { readonly ok: true; readonly patch: UpdateKeyPatch }
	| { readonly ok: false; readonly error: UpdateRefusal }

export interface BuildUpdateInput {
	readonly body: Record<string, unknown>
	/** Every other key's name and id, for the uniqueness check. */
	readonly otherNames: readonly { readonly id: string; readonly name: string }[]
	readonly id: string
	/** Non-null when the caller is a key session; `null` for a password session. */
	readonly creatorScope: CreatorScope | null
	readonly endpointKinds: readonly string[]
	readonly matchesAllowedModels: (patterns: readonly string[], model: string) => boolean
	/** The permissions a key session is forced to, whatever it sends. */
	readonly defaultPermissions: unknown
}

const LIMIT_KINDS = ["cost", "requests"] as const

function asNumber(value: unknown): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Apply only the fields the caller actually sent.
 *
 * "Sent" means present in the body, not truthy: clearing a prompt or an expiry
 * date is a real edit, and a truthiness test would silently ignore it.
 */
export function buildKeyUpdate(input: BuildUpdateInput): UpdateResult {
	const { body, creatorScope } = input
	const patch: Record<string, unknown> = {}

	if (body.name !== undefined) {
		const name = typeof body.name === "string" ? body.name.trim() : ""
		if (name.length === 0) {
			return { ok: false, error: { field: "name", message: "Name is required" } }
		}
		const clash = input.otherNames.some((other) => other.id !== input.id && other.name === name)
		if (clash) {
			return {
				ok: false,
				error: {
					field: "name",
					message: `A key named "${name}" already exists. Use a different name.`,
				},
			}
		}
		patch.name = name
	}

	if (body.isActive !== undefined) patch.isActive = body.isActive
	if (body.usedTokens !== undefined) patch.usedTokens = asNumber(body.usedTokens)
	if (body.lastResetAt !== undefined) patch.lastResetAt = body.lastResetAt
	if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt
	if (body.resetInterval !== undefined) patch.resetInterval = body.resetInterval
	if (body.rpmLimit !== undefined) patch.rpmLimit = asNumber(body.rpmLimit)
	if (body.tpmLimit !== undefined) patch.tpmLimit = asNumber(body.tpmLimit)
	// `|| 0` in the original, which also turned `NaN` into 0 — same result, said once.
	if (body.requestLimit !== undefined) patch.requestLimit = asNumber(body.requestLimit)
	if (body.expiresAt !== undefined) patch.expiresAt = body.expiresAt || null

	if (body.limitKind !== undefined) {
		patch.limitKind = LIMIT_KINDS.includes(body.limitKind as (typeof LIMIT_KINDS)[number])
			? body.limitKind
			: "tokens"
	}

	if (body.tokenLimit !== undefined) {
		const limit = asNumber(body.tokenLimit)
		const creatorMax = creatorScope?.tokenLimit ?? 0
		if (creatorMax > 0 && limit > creatorMax) {
			return {
				ok: false,
				error: {
					field: "tokenLimit",
					message: `Token limit cannot exceed your maximum (${creatorMax}).`,
				},
			}
		}
		patch.tokenLimit = limit
	}

	if (body.dailyCostLimit !== undefined) {
		const limit = asNumber(body.dailyCostLimit)
		const creatorMax = creatorScope?.dailyCostLimit ?? 0
		if (creatorMax > 0 && limit > creatorMax) {
			return {
				ok: false,
				error: {
					field: "dailyCostLimit",
					message: `Daily cost limit cannot exceed your maximum ($${creatorMax}).`,
				},
			}
		}
		patch.dailyCostLimit = limit
	}

	if (body.allowedModels !== undefined) {
		const requested = typeof body.allowedModels === "string" ? body.allowedModels : "*"
		patch.allowedModels =
			creatorScope === null
				? requested
				: clampAllowedModels(
						requested,
						parseCreatorPatterns(creatorScope.allowedModels),
						input.matchesAllowedModels,
					)
	}

	if (body.allowedEndpoints !== undefined) {
		const validated = validateEndpointKinds(body.allowedEndpoints, input.endpointKinds)
		if (validated.ok === false) {
			return {
				ok: false,
				error: { field: "allowedEndpoints", message: validated.error },
			}
		}
		// De-duplicate: the stored column is a list, and writing the same kind twice
		// would make an equality check on it fail for no reason.
		const kinds = Array.isArray(validated.value) ? validated.value : []
		const unique = [...new Set(kinds)]
		patch.allowedEndpoints =
			creatorScope === null ? unique : clampEndpoints(unique, creatorScope.allowedEndpoints)
	}

	if (body.permissions !== undefined) {
		// A key session never moves permissions; sending the field is not an error,
		// it simply cannot take effect.
		patch.permissions = creatorScope === null ? body.permissions : input.defaultPermissions
	}

	return { ok: true, patch }
}
