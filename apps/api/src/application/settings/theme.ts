/**
 * Read and change the site-wide theme.
 *
 * Reading never fails or needs a session — the login page applies the theme
 * before anyone signs in. Writing checks the session role, then stores.
 */

import { forbidden, unauthorized } from "../../domain/errors.ts"
import {
	normalizeTheme,
	refuseThemeWrite,
	THEME_REFUSAL_MESSAGE,
	type Theme,
} from "../../domain/theme.ts"
import type { SettingsPort } from "./login-gate.ts"

export interface ThemeSession {
	readonly role?: string | null
}

export function makeGetTheme(settings: SettingsPort) {
	return async (): Promise<{ theme: Theme }> => {
		const stored = await settings.read()
		return { theme: normalizeTheme(stored.theme) }
	}
}

export function makeSetTheme(settings: SettingsPort) {
	return async (
		session: ThemeSession | null,
		requested: unknown,
	): Promise<{ theme: Theme; ok: true }> => {
		const refusal = refuseThemeWrite(session?.role)
		if (refusal === "no-session") throw unauthorized(THEME_REFUSAL_MESSAGE[refusal])
		if (refusal === "api-key-session") throw forbidden(THEME_REFUSAL_MESSAGE[refusal])

		const theme = normalizeTheme(requested)
		await settings.update({ theme })
		return { theme, ok: true }
	}
}
