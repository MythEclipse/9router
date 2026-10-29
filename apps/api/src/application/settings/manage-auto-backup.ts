import type { StoredBackupConfig } from "../../domain/auto-backup.ts"
import {
	backupPatchOf,
	isBackupTestAction,
	needsRearm,
	nextBackupAt,
	type PublicBackupConfig,
	publicBackupConfig,
} from "../../domain/auto-backup.ts"
import { invalid, unauthorized } from "../../domain/errors.ts"

export type { StoredBackupConfig }

/**
 * The scheduled backup of the whole install.
 *
 * Three operations on one screen: read the configuration, edit it, and send one now to
 * prove the credentials work. The rules — what may be stored, what the screen may see,
 * when the next run is due — live in `domain/auto-backup.ts`.
 */

/** The scheduler's view of itself, as the read and the write both report it. */
export interface SchedulerState {
	readonly schedulerActive: boolean
	readonly nextRunAt?: number | null
}

export interface BackupStatus {
	readonly lastSentAt?: string | null
	readonly lastError?: string | null
}

export interface AutoBackupDeps {
	readonly config: () => Promise<StoredBackupConfig>
	readonly status: () => Promise<BackupStatus>
	readonly saveConfig: (patch: Record<string, unknown>) => Promise<StoredBackupConfig>
	/** Read the live scheduler's state. */
	readonly scheduler: () => SchedulerState
	/** Arm the scheduler from the stored configuration. Idempotent. */
	readonly configure: () => Promise<void>
	/** Send one backup now; answers its size and the channel it used. */
	readonly sendNow: () => Promise<{ sizeBytes: number; channel: string }>
	readonly verifyPassword: (password: string | null) => Promise<boolean>
}

/** What the screen reads: the config it may see, the status, and the countdown. */
export interface BackupView {
	readonly config: PublicBackupConfig
	readonly status: BackupStatus
	readonly nextRunAt: number | null
}

/**
 * The due time, given a config, a status and whatever the scheduler says now.
 *
 * Factored out because all three operations answer with it, and a countdown that
 * changed depending on which request refreshed the screen would look like a bug in the
 * scheduler rather than in this file.
 */
function viewOf(
	config: StoredBackupConfig,
	status: BackupStatus,
	live: SchedulerState,
): BackupView {
	return {
		config: publicBackupConfig(config),
		status,
		nextRunAt: nextBackupAt({
			enabled: config.enabled,
			intervalHours: config.intervalHours,
			lastSentAt: status.lastSentAt,
			schedulerActive: live.schedulerActive,
			schedulerNextRunAt: live.nextRunAt,
		}),
	}
}

/**
 * `GET /api/settings/auto-backup` — the config, the status, and the countdown.
 *
 * Reading has a side effect, deliberately: if the stored config wants scheduled
 * backups but no timer is pending, the timer is re-armed. The timer lives in process
 * memory and does not survive a restart, so the alternative is a dashboard showing a
 * dead countdown until someone opens the settings form and saves it again. The
 * scheduler state is read *again* after arming, so the countdown reflects the scheduler
 * that is now running rather than the one that was not.
 */
export async function readAutoBackup(deps: AutoBackupDeps): Promise<BackupView> {
	const config = await deps.config()
	const status = await deps.status()
	if (needsRearm(config, deps.scheduler().schedulerActive)) {
		await deps.configure()
	}
	return viewOf(config, status, deps.scheduler())
}

/**
 * `PATCH /api/settings/auto-backup` — edit the configuration.
 *
 * The patch carries only what the caller sent, so editing the interval cannot erase the
 * token beside it. An empty secret means "keep the stored one", and a chat id with no
 * digits is refused instead of stored empty.
 */
export async function writeAutoBackup(
	body: Record<string, unknown>,
	deps: AutoBackupDeps,
): Promise<BackupView> {
	const { patch, refusal } = backupPatchOf(body)
	if (refusal) throw invalid(refusal)

	const config = await deps.saveConfig(patch)
	await deps.configure()
	const status = await deps.status()
	return viewOf(config, status, deps.scheduler())
}

/**
 * `POST /api/settings/auto-backup` — send one backup now.
 *
 * The password is required even though the configuration already stores the bot token:
 * a test send pushes the whole database to a third party, and the screen that can do
 * that should ask who is asking.
 *
 * A send that fails answers **`ok: false`**, not an exception. The request itself
 * succeeded — the answer is "the backup could not be delivered, here is why" — and the
 * screen shows the reason. Throwing would send it down the generic error path and lose
 * the provider's message, which is the only useful part.
 */
export async function sendAutoBackupNow(
	input: { readonly action: unknown; readonly password: string | null },
	deps: AutoBackupDeps,
): Promise<{ ok: true; sizeBytes: number; channel: string } | { ok: false; error: string }> {
	if (!isBackupTestAction(input.action)) throw invalid("Unsupported action")
	if (!(await deps.verifyPassword(input.password))) throw unauthorized("Invalid password")
	try {
		const { sizeBytes, channel } = await deps.sendNow()
		return { ok: true, sizeBytes, channel }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
