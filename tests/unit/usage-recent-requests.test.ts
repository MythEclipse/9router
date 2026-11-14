import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let tempDir
let db
const originalDataDir = process.env.DATA_DIR

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-requests-"))
	process.env.DATA_DIR = tempDir
	delete global._dbAdapter
	delete global._recentRing
	delete global._pendingRequests
	delete global._pendingTimers
	delete global._connectionMapCache
	delete global._statsEmitTimers
	delete global._lastErrorProvider
	vi.resetModules()
	db = await import("@9router/db")
	await db.initDb()
})

afterEach(async () => {
	if (originalDataDir === undefined) delete process.env.DATA_DIR
	else process.env.DATA_DIR = originalDataDir
	try {
		global._dbAdapter?.instance?.close?.()
	} catch {}
	delete global._dbAdapter
	delete global._recentRing
	delete global._pendingRequests
	delete global._pendingTimers
	delete global._connectionMapCache
	delete global._statsEmitTimers
	delete global._lastErrorProvider
	try {
		fs.rmSync(tempDir, { recursive: true, force: true })
	} catch {}
})

describe("recent requests", () => {
	it("keeps distinct same-model requests with identical token counts", async () => {
		const timestamp = new Date().toISOString()
		const base = {
			provider: "codex",
			model: "gpt-5.6-sol",
			connectionId: "codex-account",
			apiKey: "sk-recent-requests-test",
			timestamp,
			tokens: { prompt_tokens: 7411, completion_tokens: 19 },
			status: "ok",
		}

		await db.saveRequestUsage({ ...base, requestId: "codex-request-1" })
		await db.saveRequestUsage({ ...base, requestId: "codex-request-2" })

		const [active, stats] = await Promise.all([db.getActiveRequests(), db.getUsageStats("today")])

		expect(active.recentRequests).toHaveLength(2)
		expect(stats.recentRequests).toHaveLength(2)
		expect(active.recentRequests.map((request) => request.model)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-sol",
		])
	})

	it("labels every row's lane and keeps the lanes that report no tokens", async () => {
		// The stream used to be chat-only in two independent ways: the row carried no
		// lane, and a row with zero tokens was filtered out. An embedding, a System One
		// decision and an image are all billed without completion tokens, so both rules
		// had to go before those boxes could exist.
		const base = { timestamp: new Date().toISOString(), status: "success" }
		await db.saveRequestUsage({
			...base,
			provider: "openai",
			model: "gpt-5.6-sol",
			endpoint: "/api/v1/chat/completions",
			tokens: { prompt_tokens: 741, completion_tokens: 19 },
		})
		await db.saveRequestUsage({
			...base,
			provider: "openai",
			model: "text-embedding-3-small",
			endpoint: "/api/v1/embeddings",
			tokens: { prompt_tokens: 12, completion_tokens: 0 },
		})
		await db.saveRequestUsage({
			...base,
			provider: "opencode",
			model: "jev-1.13-free",
			endpoint: "/api/v1/systemone",
			tokens: { prompt_tokens: 0, completion_tokens: 0 },
		})

		const [active, stats] = await Promise.all([db.getActiveRequests(), db.getUsageStats("today")])
		for (const rows of [active.recentRequests, stats.recentRequests]) {
			expect(rows.map((request) => request.kind).sort()).toEqual(["embedding", "llm", "systemone"])
		}
	})
})
