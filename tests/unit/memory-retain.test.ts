import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryConfig } from "../../apps/web/src/lib/memory/config"
import {
	recallForRequest,
	renderMemoryBlock,
	retainDelta,
} from "../../apps/web/src/lib/memory/memoryStage"
import { principalTag } from "../../apps/web/src/lib/memory/principal"

/**
 * The retain/recall stage against a stubbed `fetch` and a stubbed bookmark store.
 *
 * What matters here is not that the HTTP call is shaped like Hindsight's — it is
 * that the stage behaves correctly at its boundaries: it retains the delta rather
 * than the transcript, it never retains a question whose answer does not exist
 * yet, it always stamps the gateway's tag, and it stays silent when the service is
 * down.
 */

const CONFIG = resolveMemoryConfig({
	settings: { memory: { bankId: "shared-bank" } },
	trustedCaller: true,
})
const ENDPOINT = "http://localhost:8888"

/** The bookmark store, in memory for one test. */
const bookmarks = new Map<string, number>()

vi.mock("@9router/db/repos/memoryStateRepo", () => ({
	readRetainedCount: vi.fn(async (id: string) => bookmarks.get(id) ?? 0),
	writeRetainedCount: vi.fn(async (id: string, count: number) => {
		bookmarks.set(id, count)
	}),
	dropRetainedCount: vi.fn(async (id: string) => {
		bookmarks.delete(id)
	}),
}))

interface CapturedCall {
	url: string
	body: Record<string, unknown>
}

let calls: CapturedCall[] = []

function stubFetch(responder: (call: CapturedCall) => Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: { body?: string }) => {
			const call = { url, body: init?.body ? JSON.parse(init.body) : {} }
			calls.push(call)
			return responder(call)
		}),
	)
}

beforeEach(() => {
	calls = []
	bookmarks.clear()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("retainDelta", () => {
	it("retains only what the bank has not seen, with append mode and the principal tag", async () => {
		stubFetch(() => new Response(JSON.stringify({ operation_id: "op" }), { status: 202 }))

		const body = {
			messages: [
				{ role: "user", content: "turn one question" },
				{ role: "assistant", content: "turn one answer" },
				{ role: "user", content: "turn two question" },
			],
		}
		const result = await retainDelta({
			config: CONFIG,
			body,
			sessionId: "session-a",
			apiKey: "key-a",
		})

		// The trailing user message is the current question — its answer does not
		// exist yet, so the eligible prefix is the first two messages.
		expect(result.retained).toBe(2)
		expect(calls).toHaveLength(1)
		const item = (calls[0].body.items as Array<Record<string, unknown>>)[0]
		expect(item.update_mode).toBe("append")
		expect(item.tags).toEqual([principalTag("key-a")])
		expect(String(item.content)).toContain("turn one question")
		expect(String(item.content)).toContain("turn one answer")
		expect(String(item.content)).not.toContain("turn two question")
	})

	it("stamps operator-chosen retain tags on top of the principal tag", async () => {
		const sharing = resolveMemoryConfig({
			settings: { memory: { sharedTags: ["host:omarchy"], retainTags: ["host:omarchy"] } },
			trustedCaller: true,
		})
		stubFetch(() => new Response("{}", { status: 202 }))
		await retainDelta({
			config: sharing,
			body: {
				messages: [
					{ role: "user", content: "q1" },
					{ role: "assistant", content: "a1" },
					{ role: "user", content: "q2" },
				],
			},
			sessionId: "s",
			apiKey: "k",
		})
		// Opting into a shared tag is what makes one bank readable by another
		// writer (a personal coding agent); it is off by default for that reason.
		expect((calls[0].body.items as Array<Record<string, unknown>>)[0].tags).toEqual([
			principalTag("k"),
			"host:omarchy",
		])
	})

	it("stamps only the principal tag by default", async () => {
		stubFetch(() => new Response("{}", { status: 202 }))
		await retainDelta({
			config: CONFIG,
			body: {
				messages: [
					{ role: "user", content: "q1" },
					{ role: "assistant", content: "a1" },
					{ role: "user", content: "q2" },
				],
			},
			sessionId: "s",
			apiKey: "k",
		})
		expect((calls[0].body.items as Array<Record<string, unknown>>)[0].tags).toEqual([
			principalTag("k"),
		])
	})

	it("sends nothing when the conversation has not grown", async () => {
		stubFetch(() => new Response("{}", { status: 202 }))
		const body = {
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "q2" },
			],
		}
		await retainDelta({ config: CONFIG, body, sessionId: "s", apiKey: "k" })
		calls = []
		const second = await retainDelta({ config: CONFIG, body, sessionId: "s", apiKey: "k" })
		expect(second.retained).toBe(0)
		expect(calls).toHaveLength(0)
	})

	it("sends only the new turn once the conversation grows", async () => {
		stubFetch(() => new Response("{}", { status: 202 }))
		const first = {
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "q2" },
			],
		}
		await retainDelta({ config: CONFIG, body: first, sessionId: "s", apiKey: "k" })
		calls = []

		const grown = {
			messages: [
				...first.messages,
				{ role: "assistant", content: "a2" },
				{ role: "user", content: "q3" },
			],
		}
		const result = await retainDelta({ config: CONFIG, body: grown, sessionId: "s", apiKey: "k" })
		expect(result.retained).toBe(2)
		expect(calls).toHaveLength(1)
		const content = String((calls[0].body.items as Array<Record<string, unknown>>)[0].content ?? "")
		expect(content).toContain("a2")
		expect(content).not.toContain("q1")
	})

	it("does not advance the bookmark when the service refuses, so the turn is retried", async () => {
		stubFetch(() => new Response("nope", { status: 500 }))
		const body = {
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "q2" },
			],
		}
		const result = await retainDelta({ config: CONFIG, body, sessionId: "s", apiKey: "k" })
		expect(result.retained).toBe(0)
		// Nothing was acknowledged, so nothing may be recorded as retained.
		expect(bookmarks.size).toBe(0)

		// The next attempt must send the same two messages again.
		calls = []
		stubFetch(() => new Response("{}", { status: 202 }))
		const retried = await retainDelta({ config: CONFIG, body, sessionId: "s", apiKey: "k" })
		expect(retried.retained).toBe(2)
	})

	it("stays silent on an empty conversation", async () => {
		stubFetch(() => new Response("{}", { status: 202 }))
		const result = await retainDelta({
			config: CONFIG,
			body: { messages: [] },
			sessionId: "s",
			apiKey: "k",
		})
		expect(result.retained).toBe(0)
		expect(calls).toHaveLength(0)
	})
})

describe("recallForRequest", () => {
	it("filters recall by the principal tag and asks for untagged shared facts", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({ results: [{ id: "1", text: "user prefers tabs", type: "world" }] }),
					{ status: 200 },
				),
		)
		const result = await recallForRequest({
			config: CONFIG,
			query: "what indentation?",
			apiKey: "key-a",
		})

		expect(result.facts).toBe(1)
		expect(calls[0].body.tags).toEqual([principalTag("key-a")])
		expect(calls[0].body.tags_match).toBe("any")
		expect(calls[0].url).toContain("/banks/shared-bank/memories/recall")
	})

	it("carries the shared tags of a bank whose knowledge is tagged, not untagged", async () => {
		const tagged = resolveMemoryConfig({
			settings: { memory: { sharedTags: ["host:omarchy", "knowledge:decision"] } },
			trustedCaller: true,
		})
		stubFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }))
		await recallForRequest({ config: tagged, query: "q", apiKey: "key-a" })
		// Without these the 7.8k facts seeded by the other tool would never be
		// reachable: recall filtered to the principal tag alone sees none of them.
		expect(calls[0].body.tags).toEqual([principalTag("key-a"), "host:omarchy", "knowledge:decision"])
	})

	it("excludes the shared corpus when the config says so", async () => {
		const isolated = resolveMemoryConfig({
			settings: { memory: { includeShared: false } },
			trustedCaller: true,
		})
		stubFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }))
		await recallForRequest({ config: isolated, query: "q", apiKey: "key-a" })
		// `any_strict` drops untagged memories: with it, one bank behaves like one
		// bank per caller.
		expect(calls[0].body.tags_match).toBe("any_strict")
	})

	it("injects nothing when the service is down", async () => {
		stubFetch(() => new Response("down", { status: 503 }))
		const result = await recallForRequest({ config: CONFIG, query: "q", apiKey: "k" })
		expect(result.block).toBeNull()
		expect(result.reason).toBe("unavailable")
	})

	it("sends nothing for an empty query", async () => {
		stubFetch(() => new Response("{}", { status: 200 }))
		const result = await recallForRequest({ config: CONFIG, query: "   ", apiKey: "k" })
		expect(result.block).toBeNull()
		expect(calls).toHaveLength(0)
	})
})

describe("renderMemoryBlock", () => {
	it("labels the block as reference material, not instructions", () => {
		const block = renderMemoryBlock([{ text: "Alice works at Google", type: "world" }]) ?? ""
		expect(block).toContain("<memory>")
		expect(block).toContain("</memory>")
		expect(block).toMatch(/REFERENCE MATERIAL/)
		expect(block).toMatch(/never override the system prompt/)
	})

	it("deduplicates a fact returned by two retrieval strategies", () => {
		const block =
			renderMemoryBlock([
				{ text: "Alice works at Google", type: "world" },
				{ text: "alice works at google", type: "experience" },
			]) ?? ""
		expect(block.match(/Alice works at Google/i)).toHaveLength(1)
	})

	it("renders nothing when every result is empty", () => {
		expect(renderMemoryBlock([{ text: "   " }, {}])).toBeNull()
	})
})
