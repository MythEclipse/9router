import "server-only"

import { verifyDashboardPassword } from "@9router/auth/dashboardSession"
import {
	getAutoBackupConfig,
	getAutoBackupStatus,
	setAutoBackupConfig,
} from "@9router/db/repos/autoBackupRepo"
import type {
	AutoBackupDeps,
	BackupStatus,
	SchedulerState,
	StoredBackupConfig,
} from "9router-api/application/settings/manage-auto-backup"
import {
	configureTelegramBackup,
	getTelegramBackupState,
	sendTelegramBackupNow,
} from "@/shared/services/telegramBackup"

/**
 * The backup scheduler and its stored configuration, on the other side of the ports.
 *
 * The scheduler itself lives in this process (`apps/web`), which is why its state is
 * read through a function rather than being assumed: a second process reading the
 * configuration would see `schedulerActive: false` and be right about itself and wrong
 * about the install.
 */
export function createAutoBackupDeps(): AutoBackupDeps {
	return {
		config: async () => normaliseConfig(await getAutoBackupConfig()),

		status: async () => normaliseStatus(await getAutoBackupStatus()),

		saveConfig: async (patch) => normaliseConfig(await setAutoBackupConfig(patch)),

		scheduler: (): SchedulerState => {
			const state = getTelegramBackupState() as {
				schedulerActive?: boolean
				nextRunAt?: number | null
			}
			return {
				schedulerActive: state?.schedulerActive === true,
				nextRunAt: typeof state?.nextRunAt === "number" ? state.nextRunAt : null,
			}
		},

		configure: async () => {
			await configureTelegramBackup()
		},

		sendNow: async () => {
			const { sizeBytes, channel } = await sendTelegramBackupNow()
			return { sizeBytes, channel }
		},

		verifyPassword: (password) => verifyDashboardPassword(password),
	}
}

/**
 * The stored row, narrowed to what the use-case declares.
 *
 * The repository's columns are loosely typed — it reads a `SELECT` with no schema — so
 * the coercion happens here, once, rather than at each place the use-case reads a
 * field.
 */
function normaliseConfig(config: object): StoredBackupConfig {
	const fields = config as Record<string, unknown>
	return {
		enabled: fields.enabled === true,
		channel: fields.channel === "github" ? "github" : "telegram",
		intervalHours: Number(fields.intervalHours ?? 1),
		tgChatId: fields.tgChatId == null ? null : String(fields.tgChatId),
		ghRepo: fields.ghRepo == null ? null : String(fields.ghRepo),
		tgBotToken: fields.tgBotToken == null ? null : String(fields.tgBotToken),
		ghToken: fields.ghToken == null ? null : String(fields.ghToken),
	}
}

function normaliseStatus(status: Record<string, unknown>): BackupStatus {
	return {
		lastSentAt: status?.lastSentAt == null ? null : String(status.lastSentAt),
		lastError: status?.lastError == null ? null : String(status.lastError),
	}
}
