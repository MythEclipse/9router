/**
 * Settings port adapter over the shared SQLite layer.
 *
 * The settings row lives in the same database the gateway writes, so this
 * reads through `@9router/db` rather than opening a second connection.
 */
import { getSettings, updateSettings } from "@9router/db/repos/settingsRepo"
import type { LoginGateSettings, SettingsPort } from "../application/settings/login-gate.ts"

export function createSettingsPort(): SettingsPort {
	return {
		async read(): Promise<LoginGateSettings> {
			const settings = await getSettings()
			return {
				requireLogin: settings.requireLogin,
				tunnelDashboardAccess: settings.tunnelDashboardAccess,
				tunnelUrl: settings.tunnelUrl,
				tailscaleUrl: settings.tailscaleUrl,
				theme: settings.theme,
			}
		},

		async update(changes: Record<string, unknown>): Promise<void> {
			await updateSettings(changes)
		},
	}
}
