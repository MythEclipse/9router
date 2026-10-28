/**
 * Locale rules.
 *
 * Pure: which locales exist, what a requested one becomes, and how long the
 * choice is remembered. The route keeps only the cookie write, because
 * `next/headers` is transport.
 *
 * The supported list is *passed in*, never restated here. The dashboard owns
 * the translations and already declares its locales; a second copy in this
 * package would drift the moment a language is added, and the failure mode is
 * silent — the setting is accepted and the UI falls back to English.
 */

export const DEFAULT_LOCALE = "en"

export const LOCALE_COOKIE_NAME = "locale"

/** A year: the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365

/**
 * Resolve a requested locale against what the caller actually supports.
 *
 * Returns null rather than defaulting when it cannot match: this backs a POST
 * whose only job is to apply the user's choice, and answering "ok" while
 * storing something else is the one thing it must not do.
 *
 * A full tag is matched first, then its primary subtag — that is the shape a
 * browser `Accept-Language` header sends (`pt-BR,pt;q=0.9`), and it lets
 * `de-AT` land on `de` without enumerating every region.
 */
export function resolveLocale(requested: unknown, supported: readonly string[]): string | null {
	if (typeof requested !== "string") return null
	const trimmed = requested.trim()
	if (trimmed === "") return null

	const exact = supported.find((locale) => locale.toLowerCase() === trimmed.toLowerCase())
	if (exact) return exact

	const primary = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? ""
	if (primary === "") return null
	return supported.find((locale) => locale.toLowerCase() === primary) ?? null
}
