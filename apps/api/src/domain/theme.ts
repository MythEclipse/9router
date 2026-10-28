/**
 * Theme rules.
 *
 * Pure. The theme is a site-wide setting, which is why writing it is the
 * administrator's job and not a per-browser preference — the authorization
 * check needs a session role, so it lives in the use-case; the normalisation
 * and the "is this role allowed" question are decidable here.
 */

export type Theme = "dark" | "glass"

/** What every visitor sees until an administrator chooses otherwise. */
export const DEFAULT_THEME: Theme = "glass"

/**
 * Anything that is not explicitly `dark` reads as the default.
 *
 * Deliberately total rather than throwing: the theme is applied to every page
 * on load, so a stored value from an older build must not blank the site.
 */
export function normalizeTheme(value: unknown): Theme {
	return value === "dark" ? "dark" : DEFAULT_THEME
}

/**
 * Why a key-signed session may read the theme but not write it.
 *
 * A key is scoped to the gateway's traffic; the theme changes what every
 * operator sees in the dashboard. Reading it is public because the login page
 * needs it before anyone has a session.
 */
export type ThemeWriteRefusal = "no-session" | "api-key-session"

export function refuseThemeWrite(role: string | null | undefined): ThemeWriteRefusal | null {
	if (!role) return "no-session"
	if (role === "apikey") return "api-key-session"
	return null
}

export const THEME_REFUSAL_MESSAGE: Record<ThemeWriteRefusal, string> = {
	"no-session": "Sign in to change the theme",
	"api-key-session":
		"The theme applies to the whole site and can only be changed from a password sign-in",
}
