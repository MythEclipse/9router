import { describe, expect, it } from "vitest"
import {
	backupPatchOf,
	clampIntervalHours,
	isBackupTestAction,
	MIN_BACKUP_INTERVAL_HOURS,
	needsRearm,
	nextBackupAt,
	publicBackupConfig,
	telegramChatIdOf,
} from "../../apps/api/src/domain/auto-backup.ts"

describe("publicBackupConfig", () => {
	const stored = {
		enabled: true,
		channel: "github" as const,
		intervalHours: 6,
		tgChatId: "12345",
		ghRepo: "owner/repo",
		tgBotToken: "tg-secret",
		ghToken: "gh-secret",
	}

	it("never echoes a token back to the dashboard", () => {
		const view = publicBackupConfig(stored)
		expect(JSON.stringify(view)).not.toContain("tg-secret")
		expect(JSON.stringify(view)).not.toContain("gh-secret")
	})

	it("says whether a token is stored without saying which", () => {
		expect(publicBackupConfig(stored)).toMatchObject({ hasTgToken: true, hasGhToken: true })
	})

	it("reports the fields the screen edits", () => {
		expect(publicBackupConfig(stored)).toMatchObject({
			enabled: true,
			channel: "github",
			intervalHours: 6,
			tgChatId: "12345",
			ghRepo: "owner/repo",
		})
	})

	it("turns absent strings into empty ones so the form has no nulls", () => {
		const view = publicBackupConfig({ enabled: false, channel: "telegram", intervalHours: 1 })
		expect(view).toMatchObject({ tgChatId: "", ghRepo: "", hasTgToken: false, hasGhToken: false })
	})

	it("falls back to telegram for a channel it does not know", () => {
		const view = publicBackupConfig({
			enabled: false,
			channel: "carrier-pigeon" as never,
			intervalHours: 1,
		})
		expect(view.channel).toBe("telegram")
	})
})

describe("clampIntervalHours", () => {
	it("keeps a sane value", () => {
		expect(clampIntervalHours(6)).toBe(6)
	})

	it("rounds down a fractional value", () => {
		expect(clampIntervalHours(6.9)).toBe(6)
	})

	it("floors at the minimum, so the scheduler cannot run continuously", () => {
		expect(clampIntervalHours(0)).toBe(MIN_BACKUP_INTERVAL_HOURS)
		expect(clampIntervalHours(-5)).toBe(MIN_BACKUP_INTERVAL_HOURS)
	})

	it("caps at the maximum", () => {
		expect(clampIntervalHours(1e9)).toBe(24 * 365)
	})

	it("answers the minimum for something unparseable", () => {
		expect(clampIntervalHours("often")).toBe(MIN_BACKUP_INTERVAL_HOURS)
		expect(clampIntervalHours(undefined)).toBe(MIN_BACKUP_INTERVAL_HOURS)
	})
})

describe("telegramChatIdOf", () => {
	it("keeps the digits of a numeric id", () => {
		expect(telegramChatIdOf("123456789")).toBe("123456789")
	})

	it("reduces a pasted handle or padded id to its digits", () => {
		expect(telegramChatIdOf("@123456")).toBe("123456")
		expect(telegramChatIdOf(" 123456 ")).toBe("123456")
	})

	it("refuses an id with no digits, which would fail hours later at send time", () => {
		expect(telegramChatIdOf("@no-digits-here")).toBeNull()
		expect(telegramChatIdOf("")).toBeNull()
	})
})

describe("backupPatchOf", () => {
	it("passes through a well-formed edit", () => {
		expect(
			backupPatchOf({
				enabled: true,
				channel: "github",
				intervalHours: 12,
				ghRepo: " owner/repo ",
				tgChatId: "@123",
				ghToken: " gh-token ",
			}).patch,
		).toEqual({
			enabled: true,
			channel: "github",
			intervalHours: 12,
			ghRepo: "owner/repo",
			tgChatId: "123",
			ghToken: "gh-token",
		})
	})

	it("leaves out fields the caller did not send", () => {
		expect(backupPatchOf({ intervalHours: 3 }).patch).toEqual({ intervalHours: 3 })
	})

	it("drops a wrongly typed field rather than coercing it", () => {
		expect(backupPatchOf({ enabled: "false" }).patch).not.toHaveProperty("enabled")
	})

	it("ignores a channel it does not know", () => {
		expect(backupPatchOf({ channel: "sms" }).patch).not.toHaveProperty("channel")
	})

	it("keeps the stored token when the secret field is empty", () => {
		const { patch } = backupPatchOf({ tgBotToken: "   ", ghToken: "" })
		expect(patch).not.toHaveProperty("tgBotToken")
		expect(patch).not.toHaveProperty("ghToken")
	})

	it("does not overwrite a good repo with an empty one", () => {
		expect(backupPatchOf({ ghRepo: "   " }).patch).not.toHaveProperty("ghRepo")
	})

	it("refuses a chat id with no digits", () => {
		const result = backupPatchOf({ tgChatId: "not-a-number" })
		expect(result.refusal).toBe("Owner chat id must be the numeric Telegram id")
		expect(result.patch).not.toHaveProperty("tgChatId")
	})

	it("does not refuse an empty chat id, which means leave it alone", () => {
		expect(backupPatchOf({ tgChatId: "  " }).refusal).toBeNull()
	})

	it("clamps the interval it stores", () => {
		expect(backupPatchOf({ intervalHours: 0 }).patch.intervalHours).toBe(1)
	})
})

describe("nextBackupAt", () => {
	const now = 1_700_000_000_000

	it("answers nothing when backups are off", () => {
		expect(nextBackupAt({ enabled: false, intervalHours: 6, schedulerActive: true, now })).toBeNull()
	})

	it("trusts the live scheduler while it runs", () => {
		expect(
			nextBackupAt({
				enabled: true,
				intervalHours: 6,
				schedulerActive: true,
				schedulerNextRunAt: now + 1234,
				now,
			}),
		).toBe(now + 1234)
	})

	it("ignores a scheduler that is active but has no due time", () => {
		expect(
			nextBackupAt({
				enabled: true,
				intervalHours: 6,
				lastSentAt: new Date(now - 3_600_000).toISOString(),
				schedulerActive: true,
				schedulerNextRunAt: Number.NaN,
				now,
			}),
		).toBe(now - 3_600_000 + 6 * 3_600_000)
	})

	it("derives the due time from the last send when the scheduler is idle", () => {
		expect(
			nextBackupAt({
				enabled: true,
				intervalHours: 6,
				lastSentAt: new Date(now - 3_600_000).toISOString(),
				schedulerActive: false,
				now,
			}),
		).toBe(now - 3_600_000 + 6 * 3_600_000)
	})

	it("reports an overdue backup as overdue instead of pinning it to now", () => {
		const overdue = nextBackupAt({
			enabled: true,
			intervalHours: 1,
			lastSentAt: new Date(now - 10 * 3_600_000).toISOString(),
			schedulerActive: false,
			now,
		})
		expect(overdue).toBeLessThan(now)
	})

	it("answers now when nothing has ever been sent", () => {
		expect(nextBackupAt({ enabled: true, intervalHours: 6, schedulerActive: false, now })).toBe(now)
	})

	it("answers now for an unreadable last-sent date", () => {
		expect(
			nextBackupAt({
				enabled: true,
				intervalHours: 6,
				lastSentAt: "yesterday-ish",
				schedulerActive: false,
				now,
			}),
		).toBe(now)
	})
})

describe("needsRearm", () => {
	it("re-arms an enabled config whose scheduler a restart killed", () => {
		expect(needsRearm({ enabled: true }, false)).toBe(true)
	})

	it("leaves a running scheduler alone", () => {
		expect(needsRearm({ enabled: true }, true)).toBe(false)
	})

	it("does not re-arm backups the operator turned off", () => {
		expect(needsRearm({ enabled: false }, false)).toBe(false)
	})
})

describe("isBackupTestAction", () => {
	it("accepts the one action a test send takes", () => {
		expect(isBackupTestAction("test")).toBe(true)
	})

	it("refuses anything else", () => {
		expect(isBackupTestAction("send")).toBe(false)
		expect(isBackupTestAction(undefined)).toBe(false)
		expect(isBackupTestAction(1)).toBe(false)
	})
})
