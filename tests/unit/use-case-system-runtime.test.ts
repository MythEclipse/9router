import { describe, expect, it } from "vitest"

import { makeWritePlugins } from "../../apps/api/src/application/plugins/manage-plugins.ts"
import { makeCacheStats } from "../../apps/api/src/application/system/cache-stats.ts"
import { makeDashboardJobs } from "../../apps/api/src/application/system/dashboard-jobs.ts"
import {
	makeShutdownFromDashboard,
	makeShutdownFromHook,
	type ShutdownPorts,
} from "../../apps/api/src/application/system/shutdown.ts"

function pluginHarness() {
	const stored: { customPlugins?: unknown } = {}
	let cleared = 0
	const settings = {
		async read() {
			return stored
		},
		async update(changes: Record<string, unknown>) {
			Object.assign(stored, changes)
		},
	}
	const write = makeWritePlugins(
		settings,
		{ keys: ["adaptiveThinking"] },
		{
			clear() {
				cleared++
			},
		},
	)
	return { write, stored, clearedMarks: () => cleared }
}

describe("writePlugins", () => {
	it("normalises and stores, then clears the runtime cache", async () => {
		const h = pluginHarness()
		const result = await h.write({
			customPlugins: { adaptiveThinking: { enabled: true, models: ["gpt-4o"] } },
		})
		expect(result.customPlugins.adaptiveThinking).toEqual({ enabled: true, models: ["gpt-4o"] })
		expect(h.clearedMarks()).toBe(1)
	})

	it("refuses a body that is not a plugin payload", async () => {
		const h = pluginHarness()
		await expect(h.write([1, 2, 3])).rejects.toThrow(/Invalid customPlugins payload/)
		expect(h.stored.customPlugins).toBeUndefined()
	})

	it("refuses an unknown key rather than answering 200 with it dropped", async () => {
		// A typo must not leave the caller believing the plugin was configured.
		const h = pluginHarness()
		await expect(h.write({ customPlugins: { adaptiveThinkin: { enabled: true } } })).rejects.toThrow(
			/Invalid customPlugins payload/,
		)
		expect(h.stored.customPlugins).toBeUndefined()
		expect(h.clearedMarks()).toBe(0)
	})

	it("does not clear the cache when the write is refused", async () => {
		const h = pluginHarness()
		await expect(h.write(null)).rejects.toThrow()
		expect(h.clearedMarks()).toBe(0)
	})

	it("stores a fresh array so the caller's object cannot mutate the stored value", async () => {
		const h = pluginHarness()
		const models = ["gpt-4o"]
		await h.write({ customPlugins: { adaptiveThinking: { enabled: true, models } } })
		models.push("smuggled")
		const stored = h.stored.customPlugins as Record<string, { models: string[] }>
		expect(stored.adaptiveThinking.models).toEqual(["gpt-4o"])
	})
})

describe("cacheStats", () => {
	it("reads without resetting, so a poll does not clear what it measures", async () => {
		let resets = 0
		const stats = { hits: 5, misses: 1, saves: 2, evictions: 0, entries: 3, ttlMs: 1000 }
		const port = makeCacheStats({
			read: () => stats,
			resetCounters() {
				resets++
			},
		})
		expect(await port.read()).toEqual(stats)
		expect(resets).toBe(0)
	})

	it("answers with the zeroed snapshot in one round trip", async () => {
		let current = { hits: 5, misses: 1, saves: 2, evictions: 0, entries: 3, ttlMs: 1000 }
		const port = makeCacheStats({
			read: () => current,
			resetCounters() {
				current = { hits: 0, misses: 0, saves: 0, evictions: 0, entries: 3, ttlMs: 1000 }
			},
		})
		expect((await port.reset()).hits).toBe(0)
	})
})

describe("dashboardJobs", () => {
	function harness(knownKinds: readonly string[] = ["proxy-test"]) {
		const created: { kind: string; payload: Record<string, unknown>; title: string }[] = []
		const jobs = [
			{ id: "a", kind: "proxy-test", title: "", status: "running" },
			{ id: "b", kind: "proxy-test", title: "", status: "done" },
			{ id: "c", kind: "proxy-test", title: "", status: "queued" },
		]
		const useCases = makeDashboardJobs(
			{
				create(kind, payload, title) {
					created.push({ kind, payload, title })
					return { jobId: "new" }
				},
				get: (id) => jobs.find((job) => job.id === id) ?? null,
				list: () => jobs,
				cancel: (id) => jobs.some((job) => job.id === id),
			},
			{ liveStatuses: ["queued", "running"], pollMs: 1000, knownKinds },
		)
		return { useCases, created }
	}

	it("starts a job and reports the poll interval", async () => {
		const h = harness()
		expect(await h.useCases.start({ kind: "proxy-test" })).toEqual({
			jobId: "new",
			pollMs: 1000,
		})
	})

	it("refuses an unknown kind before starting anything", async () => {
		// The route used to let the registry throw and reported every failure as a
		// 400 with the raw internal message, so a typo and a storage error looked alike.
		const h = harness()
		await expect(h.useCases.start({ kind: "nope" })).rejects.toThrow(/Unknown operation: nope/)
		expect(h.created).toHaveLength(0)
	})

	it("refuses a missing kind with a readable message", async () => {
		const h = harness()
		await expect(h.useCases.start({})).rejects.toThrow(/Unknown operation: \(empty\)/)
	})

	it("refuses a payload that is not an object instead of failing later", async () => {
		const h = harness()
		await expect(h.useCases.start({ kind: "proxy-test", payload: "x" })).rejects.toThrow(
			/payload must be an object/,
		)
		expect(h.created).toHaveLength(0)
	})

	it("treats an absent payload as none", async () => {
		const h = harness()
		await h.useCases.start({ kind: "proxy-test" })
		expect(h.created[0].payload).toEqual({})
	})

	it("lists only the live jobs for the bell", async () => {
		const h = harness()
		const { jobs } = await h.useCases.live()
		expect(jobs.map((job) => job.id)).toEqual(["a", "c"])
	})

	it("answers a missing job with NOT_FOUND", async () => {
		const h = harness()
		await expect(h.useCases.read("missing")).rejects.toThrow(/not found/)
	})

	it("answers a cancel of a missing job with NOT_FOUND", async () => {
		const h = harness()
		await expect(h.useCases.cancel("missing")).rejects.toThrow(/not found/)
	})
})

describe("shutdown", () => {
	function harness(order: string[] = []) {
		const ports: ShutdownPorts = {
			async closeDatabase() {
				order.push("closeDatabase")
			},
			async stopManagedProcesses() {
				order.push("stopManagedProcesses")
			},
			exitAfter(delayMs, code) {
				order.push(`exit:${delayMs}:${code}`)
			},
		}
		return { ports, order }
	}

	it("closes the database before stopping processes, and exits last", async () => {
		// The order matters: a response must flush before exit, and SQLite must not
		// be killed mid-write.
		const h = harness()
		await makeShutdownFromDashboard(h.ports)({ role: "admin" })
		expect(h.order).toEqual(["closeDatabase", "stopManagedProcesses", "exit:500:0"])
	})

	it("still exits when a cleanup step throws", async () => {
		const order: string[] = []
		const ports: ShutdownPorts = {
			async closeDatabase() {
				throw new Error("db already closed")
			},
			async stopManagedProcesses() {
				order.push("stopped")
			},
			exitAfter() {
				order.push("exit")
			},
		}
		const result = await makeShutdownFromDashboard(ports)({ role: "admin" })
		expect(result.success).toBe(true)
		expect(order).toEqual(["stopped", "exit"])
	})

	it("refuses a key session without touching the ports", async () => {
		const h = harness()
		await expect(makeShutdownFromDashboard(h.ports)({ role: "apikey" })).rejects.toThrow(
			/Only a password session/,
		)
		expect(h.order).toEqual([])
	})

	it("refuses an unreadable session without touching the ports", async () => {
		const h = harness()
		await expect(makeShutdownFromDashboard(h.ports)(null)).rejects.toThrow()
		expect(h.order).toEqual([])
	})

	it("refuses the hook in production without touching the ports", async () => {
		const h = harness()
		const shutdown = makeShutdownFromHook(h.ports, {
			nodeEnv: "production",
			secret: "s",
		})
		await expect(shutdown("Bearer s")).rejects.toThrow(/Not allowed in production/)
		expect(h.order).toEqual([])
	})

	it("answers the hook with the same sequence outside production", async () => {
		const h = harness()
		const shutdown = makeShutdownFromHook(h.ports, { nodeEnv: "development", secret: "s" })
		await shutdown("Bearer s")
		expect(h.order).toEqual(["closeDatabase", "stopManagedProcesses", "exit:500:0"])
	})
})
