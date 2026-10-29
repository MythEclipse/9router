/**
 * Notification reconciliation: which notices a scan should raise, and which it should retire.
 *
 * The scan derives conditions on every dashboard load, so it has to be idempotent in both
 * directions. Two rules make that work, and both were implicit in a loop:
 *
 * - **One notice per (key, kind, level), never one per load.** The dedupe key is what makes the
 *   scan safe to run on every page load; without it the bell fills with the same warning.
 * - **Every notice the pass did not create must be cleared — across all kinds, not just the one
 *   in play.** A key switched from a token budget to a USD budget used to leave the token warning
 *   standing forever, advising about a budget that no longer exists. So the sweep enumerates the
 *   full cross product and retires what is absent.
 *
 * The subtlety that makes the sweep correct: a key that is *not* over budget produces no state, so
 * it appears nowhere in the live set, and the sweep retires it. That is the recovery path — and it
 * only works because the sweep is driven by the key list, not by the notices found.
 */

/** Every budget a key can enforce. A notice under one must be cleared when the key switches. */
export const QUOTA_KINDS = ["tokens", "cost", "requests"] as const

/** Every severity bucket, so a warning that escalates retires its predecessor cleanly. */
export const QUOTA_LEVELS = ["warning", "critical"] as const

export type QuotaKind = (typeof QUOTA_KINDS)[number]
export type QuotaLevel = (typeof QUOTA_LEVELS)[number]

/** The notice kind quota conditions are filed under. */
export const QUOTA_NOTICE_KIND = "quota"

/** Where a quota notice links: the page that manages the key. */
export const QUOTA_NOTICE_LINK = "/dashboard/endpoint"

/** The condition a notice stands for. `keyId` is the API key's id. */
export function quotaDedupeKey(keyId: unknown, kind: unknown, level: unknown): string {
	return `quota:${String(keyId ?? "")}:${String(kind ?? "")}:${String(level ?? "")}`
}

/** One notice a scan wants to raise. */
export interface QuotaNotice {
	readonly keyId: string
	readonly dedupeKey: string
	readonly severity: "warning" | "error"
	readonly level: QuotaLevel
}

/** What `quotaPressure` reports for a key that is near or over its budget. */
export interface QuotaState {
	readonly kind?: unknown
	readonly level?: unknown
}

function normaliseLevel(level: unknown): QuotaLevel {
	return String(level ?? "") === "critical" ? "critical" : "warning"
}

/**
 * The notices to raise for this pass, plus the dedupe keys that must survive it.
 *
 * `live` is what the sweep subtracts. It holds a key for every notice *stored*, not only for the
 * ones newly inserted, so a `notify` that dedupes instead of inserting still counts as live and is
 * not retired in the same pass that raised it.
 */
export function planQuotaNotices(
	keys: readonly { readonly id?: unknown }[] | null | undefined,
	pressureOf: (key: { readonly id?: unknown }) => QuotaState | null | undefined,
): { readonly notices: QuotaNotice[]; readonly live: ReadonlySet<string> } {
	const notices: QuotaNotice[] = []
	const live = new Set<string>()
	for (const key of keys ?? []) {
		const keyId = String(key?.id ?? "")
		if (!keyId) continue
		const state = pressureOf(key)
		if (!state) continue
		const level = normaliseLevel(state.level)
		const dedupeKey = quotaDedupeKey(keyId, state.kind, level)
		live.add(dedupeKey)
		notices.push({
			keyId,
			dedupeKey,
			// A critical condition is an error, not a louder warning: the key is refusing traffic.
			severity: level === "critical" ? "error" : "warning",
			level,
		})
	}
	return { notices, live }
}

/**
 * The dedupe keys to retire after raising `live`.
 *
 * Driven by the key list rather than by the notices found, which is what makes recovery work: a
 * key back under budget produces no notice at all, so a sweep over notices would never see it and
 * the stale warning would stand forever.
 */
export function staleQuotaKeys(
	keys: readonly { readonly id?: unknown }[] | null | undefined,
	live: ReadonlySet<string>,
): string[] {
	const stale: string[] = []
	for (const key of keys ?? []) {
		const keyId = String(key?.id ?? "")
		if (!keyId) continue
		for (const kind of QUOTA_KINDS) {
			for (const level of QUOTA_LEVELS) {
				const dedupeKey = quotaDedupeKey(keyId, kind, level)
				if (!live.has(dedupeKey)) stale.push(dedupeKey)
			}
		}
	}
	return stale
}
