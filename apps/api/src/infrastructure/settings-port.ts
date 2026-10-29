/**
 * Settings port adapter over the shared SQLite layer.
 *
 * The settings row lives in the same database the gateway writes, so this
 * reads through `@9router/db` rather than opening a second connection.
 */
import { getSettings, updateSettings } from "@9router/db/repos/settingsRepo"
import type { LoginGateSettings, SettingsPort } from "../application/settings/login-gate.ts"

/**
 * The port also carries the fields the login gate never reads — `customPlugins`
 * and the pxpipe flags. They are declared here rather than in a second adapter
 * because they are all fields of the same settings row: two ports over one row
 * would let a concurrent write discard the other's field.
 */
export interface SettingsRowPort extends SettingsPort {
	read(): Promise<
		LoginGateSettings & {
			readonly customPlugins?: unknown
			readonly pxpipeEnabled?: boolean
			readonly pxpipeAutoInstall?: boolean
			readonly pxpipeMinChars?: number
			readonly pxpipeTimeoutMs?: number
		}
	>
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
				pxpipeEnabled: settings.pxpipeEnabled,
				pxpipeAutoInstall: settings.pxpipeAutoInstall,
				pxpipeMinChars: settings.pxpipeMinChars,
				pxpipeTimeoutMs: settings.pxpipeTimeoutMs,
			}
		},

		async update(changes: Record<string, unknown>): Promise<void> {
			await updateSettings(changes)
		},
	}
}
