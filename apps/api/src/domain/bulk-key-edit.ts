/**
 * Bulk editing of API keys.
 *
 * Three rules, none of which is about HTTP:
 *
 * 1. Only a password sign-in may bulk edit. A key session holding
 *    `manageApiKeys` may mint one key at a time; rewriting twenty at once is an
 *    administrator action.
 * 2. The editable field set is a whitelist and an unknown field is an error,
 *    not something ignored — a typo must not look like it worked. Key material,
 *    the secret and the permission map are deliberately absent: a bulk action
 *    that can silently rewrite a secret or a permission is one nobody re-reads.
 * 3. At most 500 keys per call, because the whole selection is rewritten in a
 *    single reply and an unbounded one hides its own latency.
 */

/** Fields a bulk edit may change. Anything else is refused by name. */
export const BULK_EDITABLE_FIELDS = [
	"isActive",
	"tokenLimit",
	"resetInterval",
	"rpmLimit",
	"tpmLimit",
	"dailyCostLimit",
	"requestLimit",
	"limitKind",
	"allowedModels",
	"expiresAt",
] as const

export type BulkEditableField = (typeof BULK_EDITABLE_FIELDS)[number]

export type BulkPatch = Partial<Record<BulkEditableField, unknown>>

/** The largest selection one call may rewrite. */
export const MAX_BULK_KEYS = 500

export type PatchParseResult =
	| { readonly ok: true; readonly patch: BulkPatch }
	| { readonly ok: false; readonly error: string }

/**
 * Validate the patch and drop nothing silently.
 *
 * A non-object patch is a rejection rather than a throw. The previous shape
 * returned `null` here and the caller read `.error` off it, so a malformed body
 * surfaced as an unhandled TypeError — a 500 telling the operator nothing.
 */
export function parseBulkPatch(patch: unknown): PatchParseResult {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		return { ok: false, error: "No editable fields given" }
	}

	const editable = new Set<string>(BULK_EDITABLE_FIELDS)
	const clean: Record<string, unknown> = {}
	for (const [field, value] of Object.entries(patch)) {
		if (!editable.has(field)) {
			return { ok: false, error: `Field "${field}" cannot be changed in bulk` }
		}
		clean[field] = value
	}

	if (Object.keys(clean).length === 0) {
		return { ok: false, error: "No editable fields given" }
	}
	return { ok: true, patch: clean }
}

export type BulkSelectionResult =
	| { readonly ok: true; readonly ids: readonly string[] }
	| { readonly ok: false; readonly error: string }

/**
 * Normalise the selection, preserving the caller's order.
 *
 * Duplicates are removed because rewriting the same key twice in one call is
 * pointless, and the first occurrence keeps the order stable so the reply's
 * `updated` list matches what the operator selected.
 */
export function parseBulkSelection(raw: unknown): BulkSelectionResult {
	const ids = Array.isArray(raw) ? [...new Set(raw.map(String).filter((id) => id.length > 0))] : []
	if (ids.length === 0) return { ok: false, error: "No keys selected" }
	if (ids.length > MAX_BULK_KEYS) {
		return { ok: false, error: `Select at most ${MAX_BULK_KEYS} keys at once` }
	}
	return { ok: true, ids }
}

/** Only a password sign-in may bulk edit; a key session never may. */
export function mayBulkEdit(role: string | null | undefined): boolean {
	return role !== "apikey"
}

/** One key's outcome in a bulk reply. */
export interface BulkOutcome {
	readonly updated: readonly string[]
	readonly missing: readonly string[]
	readonly failed: readonly { readonly id: string; readonly error: string }[]
}

/**
 * Split the selection by what the table can actually do with it.
 *
 * A key that vanished between the read and the write is reported as `missing`,
 * not as a failure: it is not an error to have lost a race with a delete, and
 * calling it one makes a successful call look broken. A write that throws is a
 * failure and is reported per key, so one bad row does not discard the others.
 */
export function splitSelection(
	requested: readonly string[],
	existing: ReadonlySet<string>,
): { readonly targets: readonly string[]; readonly missing: readonly string[] } {
	const targets: string[] = []
	const missing: string[] = []
	for (const id of requested) {
		if (existing.has(id)) targets.push(id)
		else missing.push(id)
	}
	return { targets, missing }
}
