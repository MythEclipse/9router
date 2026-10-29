import { describe, expect, it, vi } from "vitest"
import {
	type HistoryEntry,
	type HistoryRow,
	makeSettingsHistory,
	type SettingsHistoryDependencies,
} from "../../apps/api/src/application/settings/settings-history.ts"

const ENTRY: HistoryEntry = {
	id: "h1",
	at: "2026-10-29T10:00:00Z",
	snapshot: { theme: "dark", comboStrategy: "sticky" },
}

function harness(
	options: {
		entries?: HistoryEntry[]
		current?: Record<string, unknown>
		sanitizeDrops?: string[]
	} = {},
) {
	const entries = options.entries ?? [ENTRY]
	const rows: HistoryRow[] = entries.map((e) => ({
		id: e.id,
		at: e.at,
		actor: e.actor,
		reason: e.reason,
		keys: Object.keys(e.snapshot),
	}))
	let current: Record<string, unknown> = options.current ?? {
		theme: "light",
		comboStrategy: "round-robin",
	}
	const log: string[] = []
	const update = vi.fn(async (changes: Record<string, unknown>) => {
		log.push("update")
		current = { ...current, ...changes }
	})
	const snapshot: ReturnType<typeof vi.fn> = vi.fn(async () => {})
	const recordSecurityEvent: ReturnType<typeof vi.fn> = vi.fn(async () => {
		log.push("event")
	})
	const sanitize = vi.fn((patch: Record<string, unknown>) => {
		const copy = { ...patch }
		for (const key of options.sanitizeDrops ?? []) delete copy[key]
		return copy
	})

	const deps: SettingsHistoryDependencies = {
		history: {
			list: async () => rows,
			count: async () => entries.length,
			find: async (id) => entries.find((e) => e.id === id) ?? null,
		},
		sanitize,
		settings: { read: async () => current, update },
		snapshot,
		recordSecurityEvent,
		redact: (settings) => {
			const { password, oidcClientSecret, ...safe } = settings
			return safe
		},
	}
	return {
		history: makeSettingsHistory(deps),
		update,
		snapshot,
		recordSecurityEvent,
		sanitize,
		log,
	}
}

describe("settingsHistory.list", () => {
	it("returns the trail and its total", async () => {
		const { history } = harness()
		expect(await history.list({ role: "admin" })).toMatchObject({ total: 1 })
	})

	it("refuses an unauthenticated caller with 401", async () => {
		const { history } = harness()
		await expect(history.list({ role: null })).rejects.toMatchObject({ code: "UNAUTHORIZED" })
	})

	it("lets a key-signed session read the trail", async () => {
		const { history } = harness()
		await expect(history.list({ role: "apikey" })).resolves.toBeTruthy()
	})
})

describe("settingsHistory.read", () => {
	it("returns the whole before-image", async () => {
		const { history } = harness()
		expect(await history.read({ id: "h1", role: "admin" })).toMatchObject({
			snapshot: { id: "h1" },
		})
	})

	it("refuses an empty id", async () => {
		const { history } = harness()
		await expect(history.read({ id: "", role: "admin" })).rejects.toThrow("Missing history id")
	})

	it("refuses an unknown id", async () => {
		const { history } = harness()
		await expect(history.read({ id: "nope", role: "admin" })).rejects.toThrow(
			"History entry not found",
		)
	})

	it("lets a key-signed session read one entry", async () => {
		const { history } = harness()
		await expect(history.read({ id: "h1", role: "apikey" })).resolves.toBeTruthy()
	})
})

describe("settingsHistory.revert", () => {
	it("refuses a key-signed session, so a handed-out key cannot rewrite the install", async () => {
		const { history, update } = harness()
		await expect(history.revert({ id: "h1", role: "apikey" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		})
		expect(update).not.toHaveBeenCalled()
	})

	it("refuses an unauthenticated caller", async () => {
		const { history } = harness()
		await expect(history.revert({ id: "h1", role: null })).rejects.toBeTruthy()
	})

	it("restores every key of the snapshot", async () => {
		const { history, update } = harness()
		const result = await history.revert({ id: "h1", role: "admin" })
		expect(result.restored.sort()).toEqual(["comboStrategy", "theme"])
		expect(update).toHaveBeenCalledWith({ theme: "dark", comboStrategy: "sticky" })
	})

	it("restores only the keys asked for", async () => {
		const { history, update } = harness()
		await history.revert({ id: "h1", keys: ["theme"], role: "admin" })
		expect(update).toHaveBeenCalledWith({ theme: "dark" })
	})

	it("records the current row before overwriting it, so the revert is revertible", async () => {
		const { history, snapshot } = harness()
		await history.revert({ id: "h1", role: "admin" })
		expect(snapshot).toHaveBeenCalledWith(
			{ theme: "light", comboStrategy: "round-robin" },
			"revert of h1",
			expect.any(String),
		)
	})

	it("drops a secret a stored snapshot should not carry", async () => {
		const { history, update } = harness({ sanitizeDrops: ["password", "apiToken"] })
		const result = await history.revert({ id: "h1", role: "admin" })
		expect(update.mock.calls[0][0]).not.toHaveProperty("password")
		expect(result.restored).not.toContain("password")
	})

	it("refuses when sanitising leaves nothing to restore", async () => {
		const { history, update } = harness({ sanitizeDrops: ["theme", "comboStrategy"] })
		await expect(history.revert({ id: "h1", role: "admin" })).rejects.toThrow(
			"Nothing to restore from this snapshot",
		)
		expect(update).not.toHaveBeenCalled()
	})

	it("refuses a subset that matches nothing in the snapshot", async () => {
		const { history } = harness()
		await expect(history.revert({ id: "h1", keys: ["nope"], role: "admin" })).rejects.toThrow(
			"Nothing to restore from this snapshot",
		)
	})

	it("writes the security event after the change, not before", async () => {
		const { history, log } = harness()
		await history.revert({ id: "h1", role: "admin" })
		expect(log).toEqual(["update", "event"])
	})

	it("names the snapshot's time and the restored keys in the event", async () => {
		const { history, recordSecurityEvent } = harness()
		await history.revert({ id: "h1", role: "admin" })
		const event = recordSecurityEvent.mock.calls[0][0]
		expect(event.detail).toContain("2026-10-29T10:00:00Z")
		expect(event.detail).toContain("theme")
		expect(event.path).toBe("/api/settings/rollback")
	})

	it("answers with the restored keys and the redacted settings", async () => {
		const { history } = harness({ current: { password: "hash", theme: "light" } })
		const result = await history.revert({ id: "h1", role: "admin" })
		expect(result.settings).not.toHaveProperty("password")
		expect(result.settings.theme).toBe("dark")
	})

	it("refuses an empty id before reading the trail", async () => {
		const { history, update } = harness()
		await expect(history.revert({ id: "", role: "admin" })).rejects.toThrow("Missing history id")
		expect(update).not.toHaveBeenCalled()
	})
})
