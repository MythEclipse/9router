// The day rollup (`usageDaily`) is one JSON blob per day, and the write path
// used to rewrite it in full for EVERY completed request — a read, JSON.parse,
// mutate, JSON.stringify and UPSERT whose cost scales with how large the day
// already is. Measured on this repo before the change: 245us/request on a small
// day, 2.0ms at 147KB, 9.9ms at 841KB, 57.8ms at 4.1MB. On a synchronous driver
// that is event-loop time, so a busy day slowed every concurrent user.
//
// Now each request appends a small row to `usagePending` (O(1)) and a flush folds
// the batch into the blob. These tests pin the two properties that make that
// safe: the write cost no longer grows with the blob, and no reader can observe
// a rollup that is missing a request that has already been saved.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let tempDir
let db
const originalDataDir = process.env.DATA_DIR

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-day-rollup-"))
	process.env.DATA_DIR = tempDir
	// Adapter/ring/caches live on `global` to survive Next.js hot reload, so a
	// bare resetModules() would keep pointing at the previous test's database.
	delete global._dbAdapter
	delete global._recentRing
	delete global._pendingRequests
	delete global._pendingTimers
	delete global._connectionMapCache
	delete global._statsEmitTimers
	delete global._lastErrorProvider
	vi.resetModules()
	db = await import("@/lib/db/index.js")
	await db.initDb()
})

afterEach(() => {
	if (originalDataDir === undefined) delete process.env.DATA_DIR
	else process.env.DATA_DIR = originalDataDir
	try {
		global._dbAdapter?.instance?.close?.()
	} catch {
		/* already closed */
	}
	delete global._dbAdapter
	try {
		fs.rmSync(tempDir, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
})

function pad(n) {
	return n < 10 ? `0${n}` : `${n}`
}

function localDateKey(d = new Date()) {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function adapter() {
	const { getAdapter } = await import("@/lib/db/driver.js")
	return getAdapter()
}

async function save(requestId, tokens = { prompt_tokens: 100, completion_tokens: 50 }) {
	await db.saveRequestUsage({
		provider: "probe",
		model: "m1",
		connectionId: "acct-1",
		apiKey: "sk-probe-key",
		endpoint: "/v1/chat/completions",
		tokens,
		timestamp: new Date().toISOString(),
		status: "ok",
		requestId,
	})
}

// A day blob of `entries` distinct buckets per dimension — i.e. a day that has
// already seen that much traffic.
function synthDay(entries) {
	const day = {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		cachedTokens: 0,
		cost: 0,
		byProvider: {},
		byModel: {},
		byAccount: {},
		byApiKey: {},
		byEndpoint: {},
	}
	for (let i = 0; i < entries; i++) {
		for (const dim of Object.keys(day).filter((k) => k.startsWith("by"))) {
			day[dim][`synthetic-${i}|model-${i % 20}|probe`] = {
				requests: 1,
				promptTokens: 100,
				completionTokens: 50,
				cachedTokens: 0,
				cost: 0.001,
				rawModel: `model-${i % 20}`,
				provider: "probe",
			}
		}
	}
	return day
}

describe("day rollup — write cost is independent of blob size", () => {
	it("does not slow down as the day blob grows", async () => {
		const a = await adapter()

		async function measure(entries) {
			a.run(`DELETE FROM usageDaily`)
			a.run(`DELETE FROM usagePending`)
			const day = synthDay(entries)
			a.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
				localDateKey(),
				JSON.stringify(day),
			])

			const n = 60
			for (let i = 0; i < 10; i++) await save(`warm-${entries}-${i}`)
			const t0 = process.hrtime.bigint()
			for (let i = 0; i < n; i++) await save(`measure-${entries}-${i}`)
			return Number(process.hrtime.bigint() - t0) / 1000 / n // us/request
		}

		const small = await measure(5)
		const large = await measure(800)

		// The old path went from ~245us to ~9.9ms across this range (40x). A generous
		// 4x bound still fails by a wide margin if the per-request blob rewrite ever
		// comes back, without being flaky on a loaded CI machine.
		expect(large).toBeLessThan(Math.max(small * 4, 500))
	})
})

describe("day rollup — readers never miss a saved request", () => {
	it("reports an unflushed request immediately (read-your-writes)", async () => {
		const a = await adapter()
		a.run(`DELETE FROM usageDaily`)
		a.run(`DELETE FROM usagePending`)

		await save("ryw-1")

		// The delta is on disk in usagePending but not yet folded into the blob.
		expect(a.get(`SELECT COUNT(*) c FROM usagePending`).c).toBe(1)
		expect(a.get(`SELECT COUNT(*) c FROM usageDaily`).c).toBe(0)

		const stats = await db.getUsageStats("all")
		expect(stats.byProvider.probe.promptTokens).toBe(100)
		expect(stats.byProvider.probe.completionTokens).toBe(50)

		// Reading folded it in and cleared the pending log.
		expect(a.get(`SELECT COUNT(*) c FROM usagePending`).c).toBe(0)
		expect(a.get(`SELECT COUNT(*) c FROM usageDaily`).c).toBe(1)
	})

	it("keeps the delta durable on disk before any flush runs", async () => {
		const a = await adapter()
		a.run(`DELETE FROM usageDaily`)
		a.run(`DELETE FROM usagePending`)

		await save("durable-1", { prompt_tokens: 11, completion_tokens: 7 })

		const row = a.get(`SELECT entry FROM usagePending`)
		const staged = JSON.parse(row.entry)
		expect(staged.tokens.prompt_tokens).toBe(11)
		expect(staged.tokens.completion_tokens).toBe(7)
		expect(staged.provider).toBe("probe")
		expect(staged.model).toBe("m1")
	})

	it("folds repeated requests into one bucket rather than one blob per bucket", async () => {
		const a = await adapter()
		a.run(`DELETE FROM usageDaily`)
		a.run(`DELETE FROM usagePending`)

		await save("agg-1", { prompt_tokens: 10, completion_tokens: 1 })
		await save("agg-2", { prompt_tokens: 20, completion_tokens: 2 })
		await save("agg-3", { prompt_tokens: 30, completion_tokens: 3 })
		await db.flushDayRollup()

		const day = JSON.parse(a.get(`SELECT data FROM usageDaily`).data)
		expect(day.requests).toBe(3)
		expect(day.promptTokens).toBe(60)
		expect(day.completionTokens).toBe(6)
		// Every dimension aggregated into the same single bucket per key.
		expect(Object.keys(day.byProvider)).toEqual(["probe"])
		expect(day.byProvider.probe.requests).toBe(3)
		expect(day.byProvider.probe.promptTokens).toBe(60)
	})

	it("leaves nothing pending after a flush and is idempotent when called twice", async () => {
		const a = await adapter()
		a.run(`DELETE FROM usageDaily`)
		a.run(`DELETE FROM usagePending`)

		await save("idem-1")
		await db.flushDayRollup()
		const first = a.get(`SELECT data FROM usageDaily`).data
		await db.flushDayRollup()
		const second = a.get(`SELECT data FROM usageDaily`).data

		expect(second).toBe(first)
		expect(a.get(`SELECT COUNT(*) c FROM usagePending`).c).toBe(0)
	})

	it("logs lifecycle rows (pending/error) without touching the usage rollup", async () => {
		const a = await adapter()
		a.run(`DELETE FROM usageDaily`)
		a.run(`DELETE FROM usagePending`)

		await db.appendRequestLog({
			model: "m1",
			provider: "probe",
			connectionId: "acct-1",
			status: "PENDING",
		})
		await db.flushDayRollup()

		// A start marker billed nothing: it must not appear in the usage aggregate.
		expect(a.get(`SELECT COUNT(*) c FROM usageDaily`).c).toBe(0)
		expect(a.get(`SELECT COUNT(*) c FROM usageHistory`).c).toBe(1)
	})
})
