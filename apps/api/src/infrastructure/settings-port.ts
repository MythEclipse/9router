/**
 * Settings port adapter over the shared SQLite layer.
 *
 * The settings row lives in the same database the gateway writes, so this
 * reads through `@9router/db` rather than opening a second connection.
 */
import { getSettings, updateSettings } from "@9router/db/repos/settingsRepo"
import type { LoginGateSettings, SettingsPort } from "../application/settings/login-gate.ts"

/**
 * The port also carries `customPlugins`, which the login gate never reads. It is
 * declared here rather than in a second adapter because both are fields of the
 * same settings row: two ports over one row would let a concurrent write
 * discard the other's field.
 */
export interface SettingsRowPort extends SettingsPort {
	read(): Promise<LoginGateSettings & { readonly customPlugins?: unknown }>
}

export function createSettingsPort(): SettingsRowPort {
	return {
		async read() {
			const settings = await getSettings()
			return {
				requireLogin: settings.requireLogin,
				tunnelDashboardAccess: settings.tunnelDashboardAccess,
				tunnelUrl: settings.tunnelUrl,
				tailscaleUrl: settings.tailscaleUrl,
				theme: settings.theme,
				customPlugins: settings.customPlugins,
			}
		},

		async update(changes: Record<string, unknown>): Promise<void> {
			await updateSettings(changes)
		},
	}
}
