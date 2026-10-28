/**
 * Apply a locale choice.
 *
 * The only decision is whether the requested locale exists; the caller supplies
 * the supported list because the dashboard owns the translations.
 */
import { invalid } from "../../domain/errors.ts"
import { resolveLocale } from "../../domain/locale.ts"

export type ApplyLocaleResult =
	/** The caller asked for a locale that does not exist; nothing was applied. */
	| { readonly ok: false; readonly reason: "unsupported" }
	| { readonly ok: true; readonly locale: string }

export function makeResolveLocaleChoice() {
	return (requested: unknown, supported: readonly string[]): ApplyLocaleResult => {
		const locale = resolveLocale(requested, supported)
		if (!locale) return { ok: false, reason: "unsupported" }
		return { ok: true, locale }
	}
}

/**
 * The same check, for a caller that wants the failure as an error rather than
 * a value — the REST route answers 400 with this message.
 */
export function assertSupportedLocale(requested: unknown, supported: readonly string[]): string {
	const locale = resolveLocale(requested, supported)
	if (!locale) throw invalid("Invalid locale")
	return locale
}
