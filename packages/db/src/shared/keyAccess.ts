// Per-API-key access control: pure helpers (no DB, no
// request objects), shared by the DB repo, the API routes and the engine.
import {
	KEY_ACCESS_MAX_ENTRIES,
	KEY_ACCESS_MAX_ENTRY_LENGTH,
	KEY_ACCESS_UNRESTRICTED,
} from "@9router/db/shared/keyAccessConstants"

/** A key's model-access setting: unrestricted, or an allow list of patterns. */
export interface KeyAccess {
	restricted: boolean
	allow: string[]
}

/**
 * Normalize an allow list: keep strings only, trim, drop empties, de-duplicate
 * case-insensitively (the first spelling wins). Order is preserved.
 */
export function normalizeAllowList(list: unknown): string[] {
	if (!Array.isArray(list)) return []
	const seen = new Set<string>()
	const out: string[] = []
	for (const item of list) {
		if (typeof item !== "string") continue
		const entry = item.trim()
		if (!entry) continue
		const k = entry.toLowerCase()
		if (seen.has(k)) continue
		seen.add(k)
		out.push(entry)
	}
	return out
}

/**
 * Build the access object from the two apiKeys columns.
 *
 * Fails CLOSED: the restricted flag has its own INTEGER column, so a corrupt or
 * unparsable allow list can only ever shrink what a restricted key may call
 * (to nothing); it can never turn a restricted key into an unrestricted one.
 */
export function keyAccessFromColumns(restrictedCol: unknown, allowCol: unknown): KeyAccess {
	const restricted = restrictedCol === 1 || restrictedCol === true
	if (!restricted) return { restricted: false, allow: [] }
	let parsed: unknown = []
	if (typeof allowCol === "string" && allowCol) {
		try {
			parsed = JSON.parse(allowCol)
		} catch {
			parsed = []
		}
	}
	return { restricted: true, allow: normalizeAllowList(parsed) }
}

/** Columns to persist for an access object (already validated/normalized). */
export function keyAccessToColumns(access: KeyAccess | null | undefined): {
	accessRestricted: number
	accessAllow: string
} {
	const value = access || KEY_ACCESS_UNRESTRICTED
	return {
		accessRestricted: value.restricted ? 1 : 0,
		accessAllow: JSON.stringify(value.restricted ? normalizeAllowList(value.allow) : []),
	}
}

/**
 * Validate client input for an access update ({ restricted, allow }).
 * Rejects rather than repairs: wrong types, too many entries, overlong entries.
 * @returns {{ ok: true, value: {restricted: boolean, allow: string[]} } | { ok: false, error: string }}
 */
export function validateKeyAccessInput(
	input: unknown,
): { ok: true; value: KeyAccess } | { ok: false; error: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: "access must be an object { restricted, allow }" }
	}
	const record = input as Record<string, unknown>
	const extra = Object.keys(record).filter((k) => k !== "restricted" && k !== "allow")
	if (extra.length) return { ok: false, error: `access: unexpected field(s) ${extra.join(", ")}` }
	if (typeof record.restricted !== "boolean") {
		return { ok: false, error: "access.restricted must be a boolean" }
	}
	const allow = record.allow === undefined ? [] : record.allow
	if (!Array.isArray(allow) || allow.some((e) => typeof e !== "string")) {
		return { ok: false, error: "access.allow must be an array of strings" }
	}
	if (allow.length > KEY_ACCESS_MAX_ENTRIES) {
		return { ok: false, error: `access.allow has more than ${KEY_ACCESS_MAX_ENTRIES} entries` }
	}
	if (allow.some((e) => e.trim().length > KEY_ACCESS_MAX_ENTRY_LENGTH)) {
		return {
			ok: false,
			error: `access.allow entries must be at most ${KEY_ACCESS_MAX_ENTRY_LENGTH} characters`,
		}
	}
	return { ok: true, value: { restricted: record.restricted, allow: normalizeAllowList(allow) } }
}
