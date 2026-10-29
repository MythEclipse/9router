import "server-only"

import { verifyDashboardPassword } from "@9router/auth/dashboardSession"
import { verifyPollToken } from "@9router/db/importJobAuth"
import { createImportJob, getImportJob } from "@9router/db/importJobs"
import type {
	DatabaseDeps,
	StoredImportJob,
} from "9router-api/application/settings/manage-database"
import "@/lib/db/registerPostImportHooks"
import { exportDb, getDbSummary, getSettings, importDb } from "@/lib/localDb"
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy"
import { configureTelegramBackup } from "@/shared/services/telegramBackup"

/**
 * The install's own storage, on the other side of the database use-case's ports.
 *
 * Everything here is a call into `packages/db` or a module that owns a resource the
 * domain is not allowed to name: bcrypt, the SQLite file, the proxy environment, the
 * backup scheduler.
 */
export function createDatabaseDeps(): DatabaseDeps {
	return {
		verifyPassword: (password) => verifyDashboardPassword(password),

		summary: () => getDbSummary(),

		exportSections: (sections) => exportDb(sections),

		importPayload: async (payload) => {
			await importDb(payload)
		},

		/**
		 * Re-apply what an import invalidated.
		 *
		 * Both steps fail open. An import that committed must report success even if
		 * the proxy environment could not be rebuilt or the backup schedule could not be
		 * re-armed: the data is in place, and failing the request would tell the
		 * operator the restore failed when it did not.
		 */
		afterImport: async () => {
			try {
				applyOutboundProxyEnv(await getSettings())
			} catch (error) {
				console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", error)
			}
			try {
				await configureTelegramBackup()
			} catch (error) {
				console.warn(
					"[Settings][DatabaseImport] Failed to reschedule auto backup:",
					error instanceof Error ? error.message : error,
				)
			}
		},

		startJob: (payload) => {
			const job = createImportJob(payload)
			return { jobId: job.jobId, status: job.status, pollToken: job.pollToken }
		},

		/**
		 * Normalised here because the stored job carries more than the poll answers
		 * (`done`/`total` are for the dashboard's progress bar; `percent` is what the
		 * endpoint returns), and because the token is a detail the use-case compares
		 * through a port rather than reaching for.
		 */
		findJob: (jobId) => {
			const job = getImportJob(jobId)
			if (!job) return null
			const normalised: StoredImportJob = {
				status: job.status,
				progress: job.progress
					? { percent: job.progress.percent, currentSection: job.progress.currentSection }
					: null,
				message: job.message ?? null,
				error: job.error ?? null,
			}
			return normalised
		},

		verifyPollToken: (job, token) => verifyPollToken(job as never, token),
	}
}
