import { describe, expect, it } from "vitest"

import { makePxpipe, type PxpipePort } from "../../apps/api/src/application/pxpipe/manage-pxpipe.ts"
import {
	DEFAULT_LIST_LIMIT,
	MAX_LIST_LIMIT,
	readListLimit,
} from "../../apps/api/src/domain/list-limit.ts"

describe("readListLimit", () => {
	it("defaults when absent or blank", () => {
		expect(readListLimit(null)).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: false })
		expect(readListLimit(undefined)).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: false })
		expect(readListLimit("  ")).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: false })
	})

	it("accepts an ordinary value unchanged", () => {
		expect(readListLimit("25")).toEqual({ limit: 25, adjusted: false })
	})

	it("clamps above the ceiling and says it did", () => {
		expect(readListLimit("9999")).toEqual({ limit: MAX_LIST_LIMIT, adjusted: true })
	})

	it("accepts the ceiling itself", () => {
		expect(readListLimit(String(MAX_LIST_LIMIT))).toEqual({
			limit: MAX_LIST_LIMIT,
			adjusted: false,
		})
	})

	it("rejects a negative count instead of passing it to a slice", () => {
		// `-5 || 100` is `-5`, so the old clamp let a negative through and the store
		// sliced from the wrong end of the array.
		expect(readListLimit("-5")).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: true })
	})

	it("rejects zero, which is not a smaller list but a mistake", () => {
		expect(readListLimit("0")).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: true })
	})

	it("rejects a non-number", () => {
		expect(readListLimit("abc")).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: true })
	})

	it("rejects a fraction", () => {
		expect(readListLimit("2.5")).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: true })
	})

	it("rejects Infinity", () => {
		expect(readListLimit("Infinity")).toEqual({ limit: DEFAULT_LIST_LIMIT, adjusted: true })
	})
})

function harness(overrides: Partial<PxpipePort> = {}) {
	const calls: string[] = []
	const engine: PxpipePort = {
		status: () => ({ loaded: false, version: null }),
		installInfo: () => ({ installed: true }),
		async install() {
			calls.push("install")
			return { installed: true }
		},
		async load() {
			calls.push("load")
		},
		unload() {
			calls.push("unload")
			return true
		},
		async health() {
			calls.push("health")
			return { healthy: true, checks: [] }
		},
		stats: (input) => {
			calls.push(`stats:${input.recentLimit}`)
			return { ok: true }
		},
		readEvents: (input) => {
			calls.push(`events:${input.limit}`)
			return [{ id: 1 }, { id: 2 }]
		},
		installLogTail: () => "log",
		...overrides,
	}
	let autoInstall = false
	const settings = {
		async read() {
			return { enabled: true, autoInstall, minChars: 100, timeoutMs: 5000 }
		},
	}
	return {
		pxpipe: makePxpipe(engine, settings),
		calls,
		setAutoInstall(value: boolean) {
			autoInstall = value
		},
	}
}

describe("pxpipe.start", () => {
	it("loads when already installed, without reinstalling", async () => {
		const h = harness()
		await h.pxpipe.start()
		expect(h.calls).toEqual(["load"])
	})

	it("refuses with CONFLICT when not installed and auto-install is off", async () => {
		const h = harness({ installInfo: () => ({ installed: false }) })
		await expect(h.pxpipe.start()).rejects.toMatchObject({ code: "CONFLICT" })
		expect(h.calls).toEqual([])
	})

	it("installs first when the operator allowed it", async () => {
		const h = harness({ installInfo: () => ({ installed: false }) })
		h.setAutoInstall(true)
		await h.pxpipe.start()
		expect(h.calls).toEqual(["install", "load"])
	})
})

describe("pxpipe.stop", () => {
	it("reports whether anything was actually loaded", async () => {
		const loaded = harness({ unload: () => true })
		expect((await loaded.pxpipe.stop()).stopped).toBe(true)

		const idle = harness({ unload: () => false })
		expect((await idle.pxpipe.stop()).stopped).toBe(false)
	})
})

describe("pxpipe.install", () => {
	it("unloads before the health check so health sees the fresh module", async () => {
		const h = harness()
		await h.pxpipe.install()
		expect(h.calls).toEqual(["install", "unload", "health"])
	})
})

describe("pxpipe.status", () => {
	it("folds the operator's settings into the engine's status", async () => {
		const h = harness()
		expect(await h.pxpipe.status()).toEqual({
			loaded: false,
			version: null,
			enabled: true,
			autoInstall: false,
			minChars: 100,
			timeoutMs: 5000,
		})
	})
})

describe("pxpipe.logs", () => {
	it("asks for the clamped limit and reverses to newest-first", async () => {
		const h = harness()
		const result = await h.pxpipe.logs("9999")
		expect(h.calls).toContain(`events:${MAX_LIST_LIMIT}`)
		expect(result.events).toEqual([{ id: 2 }, { id: 1 }])
		expect(result.adjusted).toBe(true)
	})

	it("reports a rejected limit so the panel can say so", async () => {
		const h = harness()
		const result = await h.pxpipe.logs("-1")
		expect(result.limit).toBe(DEFAULT_LIST_LIMIT)
		expect(result.adjusted).toBe(true)
	})

	it("does not mutate the array the engine returned", async () => {
		const source = [{ id: 1 }, { id: 2 }]
		const h = harness({ readEvents: () => source })
		await h.pxpipe.logs("10")
		expect(source).toEqual([{ id: 1 }, { id: 2 }])
	})
})

describe("pxpipe.stats", () => {
	it("passes the clamped limit", async () => {
		const h = harness()
		await h.pxpipe.stats("0")
		expect(h.calls).toContain(`stats:${DEFAULT_LIST_LIMIT}`)
	})
})
