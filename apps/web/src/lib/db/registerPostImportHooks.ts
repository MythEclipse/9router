/**
 * Wires the database package's post-import hooks back to this app.
 *
 * The shared package cannot import `apps/web` without depending on its
 * consumer, so it exposes a registry instead and each app fills in what it can
 * offer. Importing this module is what arms the hooks; the two Next handlers
 * that create an import job import it for that reason.
 */
import { registerPostImportHooks } from "@9router/db/importJobs"
import { getSettings } from "@9router/db/repos/settingsRepo"
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy"
import { configureTelegramBackup } from "@/shared/services/telegramBackup"

registerPostImportHooks({
	async reapplyOutboundProxy() {
		applyOutboundProxyEnv(await getSettings())
	},
	async rescheduleAutoBackup() {
		await configureTelegramBackup()
	},
})
