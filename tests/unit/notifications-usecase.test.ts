/**
 * The bell's rules, tested where they live.
 *
 * Four test files already cover the domain (`notification-feed-rules`, `notification-scan-rules`,
 * `notification-revival`, `quota-notifications`). None covered the use-case, which is where the
 * door, the recount and the swallowed scan failure actually are — that is what this file adds.
 */

import {
	type NotificationStore,
	readNotifications,
	updateNotification,
} from "9router-api/application/notifications/read-notifications"
import {
	type NotificationScanStore,
	scanNotifications,
} from "9router-api/application/notifications/scan-notifications"
import { describe, expect, it, vi } from "vitest"

const admin = { userId: "u1", email: "a@b.c", role: "admin" }
const keySession = { userId: "u1", email: "a@b.c", role: "apikey" }

function store(overrides: Partial<NotificationStore> = {}) {
	const calls: string[] = []
	const base: NotificationStore = {
		list: async ({ limit }) => {
			calls.push(`list:${limit}`)
			return { notifications: [], unread: 2 }
		},
		unreadCount: async () => {
			calls.push("unreadCount")
			return 7
		},
		markRead: async (id) => {
			calls.push(`markRead:${id}`)
			return { ok: true }
		},
		clearById: async (id) => {
			calls.push(`clearById:${id}`)
			return { ok: true }
		},
		clearByKind: async (kind, dk) => {
			calls.push(`clearByKind:${kind}:${dk}`)
			return { ok: true }
		},
	}
	return Object.assign({ ...base, ...overrides }, { calls })
}

describe("the feed's door", () => {
	it("turns away a request with no session", async () => {
		const s = store()
		const answer = await readNotifications(null, undefined, s)
		expect(answer.status).toBe(401)
		// Nothing read: an unauthorised caller must not learn how many rows exist.
		expect(s.calls).toEqual([])
	})

	it("turns away a key session", async () => {
		const answer = await readNotifications(keySession, undefined, store())
		expect(answer.status).toBe(401)
	})

	it("lets an admin through and forbids caching", async () => {
		const answer = await readNotifications(admin, undefined, store())
		expect(answer.status).toBe(200)
		expect(answer.headers?.["Cache-Control"]).toBe("no-store")
	})

	it("passes a positive limit through; the repo owns the ceiling", async () => {
		const s = store()
		await readNotifications(admin, "100", s)
		expect(s.calls[0]).toBe("list:100")
	})

	it("drops a limit that is not a usable number, leaving the repo's default", async () => {
		for (const raw of ["", "abc", "-5", "0", null]) {
			const s = store()
			await readNotifications(admin, raw, s)
			expect(s.calls[0]).toBe("list:undefined")
		}
	})

	it("answers 500, not a throw, when the read fails", async () => {
		const answer = await readNotifications(
			admin,
			undefined,
			store({
				list: async () => {
					throw new Error("db down")
				},
			}),
		)
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("Failed to load notifications")
	})
})

describe("clearing a notification", () => {
	it("marks all read when no id is named", async () => {
		const s = store()
		const answer = await updateNotification(admin, { action: "read" }, s)
		expect(s.calls).toContain("markRead:all")
		expect(answer.body).toEqual({ ok: true, unread: 7 })
	})

	it("marks one row read when an id is named", async () => {
		const s = store()
		await updateNotification(admin, { action: "read", id: "n1" }, s)
		expect(s.calls).toContain("markRead:n1")
	})

	it("dismisses a row", async () => {
		const s = store()
		const answer = await updateNotification(admin, { action: "clear", id: "n2" }, s)
		expect(s.calls).toContain("clearById:n2")
		expect(answer.body).toEqual({ ok: true, unread: 7 })
	})

	it("clears a resolved condition by kind and dedupe key", async () => {
		const s = store()
		const answer = await updateNotification(
			admin,
			{ action: "clear", kind: "quota", dedupeKey: "k9" },
			s,
		)
		expect(s.calls).toContain("clearByKind:quota:k9")
		expect(answer.body).toEqual({ ok: true, unread: 7 })
	})

	it("recounts on every branch, so the badge cannot go stale", async () => {
		for (const body of [
			{ action: "read" },
			{ action: "clear", id: "n1" },
			{ action: "clear", kind: "quota", dedupeKey: "d" },
		]) {
			const s = store()
			await updateNotification(admin, body, s)
			expect(s.calls).toContain("unreadCount")
		}
	})

	it("answers 400 for an action it does not do, rather than a false success", async () => {
		const answer = await updateNotification(admin, { action: "explode" }, store())
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("Unknown action")
	})

	it("refuses a key session before it writes", async () => {
		const s = store()
		const answer = await updateNotification(keySession, { action: "read" }, s)
		expect(answer.status).toBe(401)
		expect(s.calls).toEqual([])
	})
})

const wording = {
	pressure: () => ({ kind: "weekly", level: "critical" }),
	title: () => "Weekly quota critical",
	body: () => "one key is nearly out",
}

function scanStore(overrides: Partial<NotificationScanStore> = {}) {
	const calls: string[] = []
	const base: NotificationScanStore = {
		keys: async () => [{ id: 1 }],
		notify: async (input) => {
			calls.push(`notify:${input.dedupeKey}`)
			return null
		},
		clearByKind: async (kind, dk) => {
			calls.push(`clear:${kind}:${dk}`)
			return { ok: true }
		},
		clearAllOfKind: async (kind) => {
			calls.push(`sweep:${kind}`)
			return { ok: true }
		},
	}
	return Object.assign({ ...base, ...overrides }, { calls })
}

describe("deriving conditions", () => {
	it("refuses a key session instead of scanning", async () => {
		const s = scanStore()
		const answer = await scanNotifications(keySession, s, wording)
		expect(answer.status).toBe(401)
		expect(s.calls).toEqual([])
	})

	it("reports the conditions it derived", async () => {
		const answer = await scanNotifications(admin, scanStore(), wording)
		expect(answer.status).toBe(200)
		expect(answer.body.created.length).toBeGreaterThan(0)
	})

	it("sweeps stale update notices every pass", async () => {
		const s = scanStore()
		await scanNotifications(admin, s, wording)
		expect(s.calls).toContain("sweep:update")
	})

	it("keeps serving the dashboard when the scan throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const answer = await scanNotifications(
			admin,
			scanStore({
				keys: async () => {
					throw new Error("db down")
				},
			}),
			wording,
		)
		expect(answer.status).toBe(200)
		expect(answer.body.created).toEqual([])
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})

	it("does not answer 500 for a failure: the trade is documented in the use-case", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const answer = await scanNotifications(
			admin,
			scanStore({
				clearAllOfKind: async () => {
					throw new Error("db down")
				},
			}),
			wording,
		)
		expect(answer.status).toBe(200)
		warn.mockRestore()
	})
})
