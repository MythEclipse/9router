import { describe, expect, it, vi } from "vitest"
import {
	type AutoBackupDeps,
	type BackupView,
	readAutoBackup,
	sendAutoBackupNow,
	writeAutoBackup,
} from "../../apps/api/src/application/settings/manage-auto-backup.ts"
import type { StoredBackupConfig } from "../../apps/api/src/domain/auto-backup.ts"

const STORED: StoredBackupConfig = {
	enabled: true,
	channel: "telegram",
	intervalHours: 6,
	tgChatId: "123",
	ghRepo: "",
	tgBotToken: "tg-secret",
	ghToken: null,
}

function deps(
	options: Partial<AutoBackupDeps> & { schedulerActive?: boolean; nextRunAt?: number } = {},
): AutoBackupDeps {
	const { schedulerActive = true, nextRunAt = 1_000, ...rest } = options
	return {
		config: vi.fn(async () => STORED),
		status: vi.fn(async () => ({ lastSentAt: null })),
		saveConfig: vi.fn(async () => STORED),
		scheduler: vi.fn(() => ({ schedulerActive, nextRunAt })),
		configure: vi.fn(async () => undefined),
		sendNow: vi.fn(async () => ({ sizeBytes: 42, channel: "telegram" })),
		verifyPassword: vi.fn(async () => true),
		...rest,
	}
}

describe("readAutoBackup", () => {
	it("reports the config as the screen may see it, without secrets", () => {
		return readAutoBackup(deps()).then((view) => {
			expect(view.config.hasTgToken).toBe(true)
			expect(JSON.stringify(view)).not.toContain("tg-secret")
		})
	})

	it("does not re-arm a scheduler that is already running", async () => {
		const d = deps({ schedulerActive: true })
		await readAutoBackup(d)
		expect(d.configure).not.toHaveBeenCalled()
	})

	it("re-arms a scheduler a restart killed", async () => {
		const d = deps({ schedulerActive: false })
		await readAutoBackup(d)
		expect(d.configure).toHaveBeenCalledOnce()
	})

	it("does not re-arm backups the operator turned off", async () => {
		const d = deps({
			schedulerActive: false,
			config: vi.fn(async () => ({ ...STORED, enabled: false })),
		})
		await readAutoBackup(d)
		expect(d.configure).not.toHaveBeenCalled()
	})

	it("reads the scheduler again after arming, so the countdown is the live one", async () => {
		const scheduler = vi
			.fn()
			.mockReturnValueOnce({ schedulerActive: false, nextRunAt: null })
			.mockReturnValueOnce({ schedulerActive: true, nextRunAt: 5_000 })
		const d = deps({ scheduler })
		const view = await readAutoBackup(d)
		expect(scheduler).toHaveBeenCalledTimes(2)
		expect(view.nextRunAt).toBe(5_000)
	})

	it("answers no countdown when backups are off", async () => {
		const d = deps({ config: vi.fn(async () => ({ ...STORED, enabled: false })) })
		const view: BackupView = await readAutoBackup(d)
		expect(view.nextRunAt).toBeNull()
	})

	it("passes the status through untouched", async () => {
		const d = deps({ status: vi.fn(async () => ({ lastSentAt: "2026-01-01", lastError: "x" })) })
		const view = await readAutoBackup(d)
		expect(view.status).toEqual({ lastSentAt: "2026-01-01", lastError: "x" })
	})
})

describe("writeAutoBackup", () => {
	it("saves only the fields the caller sent", async () => {
		const d = deps()
		await writeAutoBackup({ intervalHours: 12 }, d)
		expect(d.saveConfig).toHaveBeenCalledWith({ intervalHours: 12 })
	})

	it("keeps a stored token when the secret was not re-typed", async () => {
		const d = deps()
		await writeAutoBackup({ intervalHours: 12, tgBotToken: "" }, d)
		expect(d.saveConfig).toHaveBeenCalledWith({ intervalHours: 12 })
	})

	it("re-arms the scheduler from the saved config", async () => {
		const d = deps()
		await writeAutoBackup({ enabled: true }, d)
		expect(d.configure).toHaveBeenCalledOnce()
	})

	it("refuses a chat id that is not numeric, without saving", async () => {
		const d = deps()
		await expect(writeAutoBackup({ tgChatId: "abc" }, d)).rejects.toThrow(
			"Owner chat id must be the numeric Telegram id",
		)
		expect(d.saveConfig).not.toHaveBeenCalled()
	})

	it("answers the same shape as the read, so the screen needs one renderer", async () => {
		const d = deps()
		const written = await writeAutoBackup({ enabled: true }, d)
		expect(Object.keys(written).sort()).toEqual(["config", "nextRunAt", "status"])
	})
})

describe("sendAutoBackupNow", () => {
	it("sends with the right action and a valid password", async () => {
		const d = deps()
		const result = await sendAutoBackupNow({ action: "test", password: "pw" }, d)
		expect(result).toEqual({ ok: true, sizeBytes: 42, channel: "telegram" })
	})

	it("refuses an action it does not know, before checking the password", async () => {
		const d = deps()
		await expect(sendAutoBackupNow({ action: "send", password: "pw" }, d)).rejects.toThrow(
			"Unsupported action",
		)
		expect(d.verifyPassword).not.toHaveBeenCalled()
	})

	it("refuses a bad password without sending", async () => {
		const d = deps({ verifyPassword: vi.fn(async () => false) })
		await expect(sendAutoBackupNow({ action: "test", password: "bad" }, d)).rejects.toThrow(
			"Invalid password",
		)
		expect(d.sendNow).not.toHaveBeenCalled()
	})

	it("answers ok:false with the provider's message instead of throwing", async () => {
		const d = deps({
			sendNow: vi.fn(async () => {
				throw new Error("chat not found")
			}),
		})
		expect(await sendAutoBackupNow({ action: "test", password: "pw" }, d)).toEqual({
			ok: false,
			error: "chat not found",
		})
	})

	it("still answers a message when the failure was not an Error", async () => {
		const d = deps({
			sendNow: vi.fn(async () => {
				throw "string failure"
			}),
		})
		const result = await sendAutoBackupNow({ action: "test", password: "pw" }, d)
		expect(result).toEqual({ ok: false, error: "string failure" })
	})
})
