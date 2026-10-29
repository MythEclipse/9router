/**
 * Rules for the scheduled backup of the whole install.
 *
 * The dashboard edits this from one screen, and every rule below answers a question
 * that screen asks where a wrong answer would be quiet.
 */

/** The shortest interval the scheduler will honour, in hours. */
export const MIN_BACKUP_INTERVAL_HOURS = 1

/** The longest interval worth storing, in hours — a year. */
export const MAX_BACKUP_INTERVAL_HOURS = 24 * 365

/** How long an hour is, in milliseconds. Named so the arithmetic reads as time. */
export const HOUR_MS = 3_600_000

/** Where a backup is sent. */
export type BackupChannel = "telegram" | "github"

/** The stored configuration, secrets included. */
export interface StoredBackupConfig {
	readonly enabled: boolean
	readonly channel: BackupChannel
	readonly intervalHours: number
	readonly tgChatId?: string | null
	readonly ghRepo?: string | null
	readonly tgBotToken?: string | null
	readonly ghToken?: string | null
}

/**
 * The configuration as the dashboard may see it.
 *
 * **Secrets are write-only.** The dashboard sends a token to store one; it never
 * receives one back. That is not squeamishness: this endpoint is reachable from a
 * browser, so a token echoed here lands in the page's memory, the devtools network
 * log, and every screenshot the operator takes while asking for help. The `has…`
 * booleans exist so the screen can say "a token is stored" without knowing it.
 */
export interface PublicBackupConfig {
	readonly enabled: boolean
	readonly channel: BackupChannel
	readonly intervalHours: number
	readonly tgChatId: string
	readonly ghRepo: string
	readonly hasTgToken: boolean
	readonly hasGhToken: boolean
}

export function publicBackupConfig(config: StoredBackupConfig): PublicBackupConfig {
	return {
		enabled: config.enabled === true,
		channel: config.channel === "github" ? "github" : "telegram",
		intervalHours: config.intervalHours,
		tgChatId: config.tgChatId || "",
		ghRepo: config.ghRepo || "",
		hasTgToken: Boolean(config.tgBotToken),
		hasGhToken: Boolean(config.ghToken),
	}
}

/**
 * The interval to store, given whatever the screen sent.
 *
 * Rounded down, floored at the minimum, capped at the maximum. The floor is the
 * important one: an interval of `0` asks the scheduler to run continuously, and a
 * negative one computes a due time in the past and does the same. An unparseable
 * value becomes the minimum rather than the current setting, because the caller asked
 * to change it and silence would look like a save that worked.
 */
export function clampIntervalHours(value: unknown): number {
	const hours = Math.floor(Number(value))
	if (!Number.isFinite(hours)) return MIN_BACKUP_INTERVAL_HOURS
	return Math.min(MAX_BACKUP_INTERVAL_HOURS, Math.max(MIN_BACKUP_INTERVAL_HOURS, hours))
}

/**
 * A Telegram owner chat id, reduced to its digits.
 *
 * Owner ids are numeric, and the input often receives one pasted from a link or a
 * message, so `"@123456"` and `"123456 "` mean the same owner. An answer with no
 * digits at all is not a chat id and must be refused rather than stored empty: an
 * empty chat id makes every scheduled run fail at send time, hours later, with nothing
 * in the screen to explain it.
 */
export function telegramChatIdOf(raw: string): string | null {
	const digits = raw.replace(/\D+/g, "")
	return digits || null
}

/**
 * The patch a settings screen asked for.
 *
 * Only fields the caller actually sent are present, because the store treats an absent
 * key as "leave it alone". A field sent with the wrong type is dropped rather than
 * coerced: a screen that sent `enabled: "false"` as a string has a bug, and storing
 * `true` because the string was non-empty would hide it.
 *
 * **An empty secret means "keep the stored one".** The dashboard renders a masked
 * token, and a save that did not touch it sends nothing at all. Without this rule,
 * editing the interval would erase a token that took five minutes to paste.
 */
export function backupPatchOf(body: Record<string, unknown>): {
	readonly patch: Record<string, unknown>
	readonly refusal: string | null
} {
	const patch: Record<string, unknown> = {}

	if (typeof body.enabled === "boolean") patch.enabled = body.enabled
	if (body.channel === "telegram" || body.channel === "github") patch.channel = body.channel
	if (body.intervalHours !== undefined) patch.intervalHours = clampIntervalHours(body.intervalHours)

	if (typeof body.ghRepo === "string" && body.ghRepo.trim()) {
		patch.ghRepo = body.ghRepo.trim()
	}

	if (typeof body.tgChatId === "string" && body.tgChatId.trim()) {
		const chatId = telegramChatIdOf(body.tgChatId)
		if (!chatId) return { patch, refusal: "Owner chat id must be the numeric Telegram id" }
		patch.tgChatId = chatId
	}

	if (typeof body.tgBotToken === "string" && body.tgBotToken.trim()) {
		patch.tgBotToken = body.tgBotToken.trim()
	}
	if (typeof body.ghToken === "string" && body.ghToken.trim()) {
		patch.ghToken = body.ghToken.trim()
	}

	return { patch, refusal: null }
}

/**
 * When the next backup is due, or null when none is scheduled.
 *
 * The live scheduler is authoritative while it runs. When it is idle — which is what a
 * process restart leaves behind, since the timer lives in memory — the due time is
 * derived from the stored `lastSentAt` instead, and reported honestly **even when it
 * is in the past**. Pinning an overdue backup to "now" made the countdown sit at
 * `00:00:00` forever, which reads as "stuck" rather than "overdue".
 */
export function nextBackupAt(input: {
	readonly enabled: boolean
	readonly intervalHours: number
	readonly lastSentAt?: string | null
	readonly schedulerActive: boolean
	readonly schedulerNextRunAt?: number | null
	readonly now?: number
}): number | null {
	if (!input.enabled) return null
	if (
		input.schedulerActive &&
		typeof input.schedulerNextRunAt === "number" &&
		Number.isFinite(input.schedulerNextRunAt)
	) {
		return input.schedulerNextRunAt
	}
	const lastSentMs = input.lastSentAt ? new Date(input.lastSentAt).getTime() : Number.NaN
	if (!Number.isFinite(lastSentMs) || lastSentMs <= 0) return input.now ?? Date.now()
	return lastSentMs + clampIntervalHours(input.intervalHours) * HOUR_MS
}

/**
 * Whether reading the config should also restart a scheduler that is not running.
 *
 * The timer lives in process memory and dies with the process. A read that finds a
 * stored config wanting backups but no pending tick has found a scheduler a restart
 * killed, and re-arming it here is what keeps the countdown alive without the operator
 * having to save the form again.
 */
export function needsRearm(config: { enabled: boolean }, schedulerActive: boolean): boolean {
	return config.enabled && !schedulerActive
}

/** The only action a test send accepts. */
export const BACKUP_TEST_ACTION = "test"

export function isBackupTestAction(action: unknown): boolean {
	return action === BACKUP_TEST_ACTION
}
