import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryConfig } from "../../apps/web/src/lib/memory/config"
import {
	deleteHindsight,
	getHindsight,
	hindsightBreakerState,
	postHindsight,
	resetHindsightBreakers,
} from "../../apps/web/src/lib/memory/hindsightClient"
import {
	memoryDocumentId,
	principalHash,
	principalTag,
} from "../../apps/web/src/lib/memory/principal"
import { lastUserQuery, plainMessages, textOf } from "../../apps/web/src/lib/memory/transcript"

const ENDPOINT = { baseUrl: "http://hindsight.test:8888", apiKey: "tok" }

afterEach(() => {
	resetHindsightBreakers()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("principal isolation", () => {
	it("derives the tag from a hash, never from the key itself", () => {
		const tag = principalTag("sk-live-secret-value")
		expect(tag).toBe(`principal:${principalHash("sk-live-secret-value")}`)
		expect(tag).not.toContain("sk-live-secret-value")
		// 32 hex chars: enough to separate callers, short enough for a log line.
		expect(principalHash("sk-live-secret-value")).toMatch(/^[0-9a-f]{32}$/)
	})

	it("gives different keys different scopes and the same key a stable one", () => {
		expect(principalHash("key-a")).not.toBe(principalHash("key-b"))
		expect(principalHash("key-a")).toBe(principalHash("key-a"))
	})

	it("puts every keyless caller in one anonymous scope", () => {
		expect(principalHash(null)).toBe("anonymous")
		expect(principalHash("")).toBe("anonymous")
		expect(principalHash("   ")).toBe("anonymous")
	})

	it("scopes a document id by principal as well as session", () => {
		const shared = memoryDocumentId("session-1", "key-a")
		expect(shared).toMatch(/^chat-[0-9a-f]{32}-[0-9a-f]{24}$/)
		// Two callers presenting the same session id must not share a document:
		// append-mode retain would otherwise write into each other's transcript.
		expect(memoryDocumentId("session-1", "key-a")).not.toBe(memoryDocumentId("session-1", "key-b"))
	})
})

describe("transcript reading", () => {
	it("reads OpenAI chat messages", () => {
		const body = {
			messages: [
				{ role: "system", content: "be brief" },
				{ role: "user", content: "first question" },
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "what did we decide?" },
			],
		}
		expect(plainMessages(body)).toHaveLength(4)
		expect(lastUserQuery(body)).toBe("what did we decide?")
	})

	it("reads Responses input and Claude content blocks", () => {
		expect(
			lastUserQuery({
				input: [{ role: "user", content: [{ type: "input_text", text: "from responses" }] }],
			}),
		).toBe("from responses")
		expect(
			lastUserQuery({
				messages: [{ role: "user", content: [{ type: "text", text: "from claude" }] }],
			}),
		).toBe("from claude")
	})

	it("reads Gemini contents and maps the model role to assistant", () => {
		const messages = plainMessages({
			contents: [
				{ role: "user", parts: [{ text: "gemini question" }] },
				{ role: "model", parts: [{ text: "gemini answer" }] },
			],
		})
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
	})

	it("truncates the query instead of sending a transcript", () => {
		const long = "x".repeat(5000)
		expect(lastUserQuery({ messages: [{ role: "user", content: long }] }).length).toBe(1000)
	})

	it("answers empty rather than throwing on an unknown shape", () => {
		expect(plainMessages(null)).toEqual([])
		expect(plainMessages({ something: "else" })).toEqual([])
		expect(lastUserQuery({})).toBe("")
		expect(textOf(undefined)).toBe("")
	})
})

describe("memory config", () => {
	it("is off unless the operator enabled it", () => {
		expect(resolveMemoryConfig({}).enabled).toBe(false)
	})

	it("lets a combo retune an enabled stage", () => {
		const config = resolveMemoryConfig(
			{
				memory: { enabled: true, bankId: "shared", recallMaxTokens: 1200 },
				comboStrategies: { public: { memory: { recallMaxTokens: 300, includeShared: false } } },
			},
			"public",
		)
		expect(config.bankId).toBe("shared")
		expect(config.recallMaxTokens).toBe(300)
		expect(config.includeShared).toBe(false)
	})

	it("never lets a combo enable a stage the operator left off", () => {
		const config = resolveMemoryConfig(
			{ memory: { enabled: false }, comboStrategies: { public: { memory: { enabled: true } } } },
			"public",
		)
		expect(config.enabled).toBe(false)
	})
})

describe("hindsight client fail-open contract", () => {
	it("returns null on a non-2xx answer instead of throwing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		)
		const result = await postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall" })
		expect(result).toBeNull()
	})

	it("returns null on a network error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED")
			}),
		)
		expect(await getHindsight(ENDPOINT, "/health", { operation: "health" })).toBeNull()
	})

	it("returns null when the deadline passes", async () => {
		vi.useFakeTimers()
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
					}),
			),
		)
		const pending = postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall", timeoutMs: 50 })
		await vi.advanceTimersByTimeAsync(60)
		expect(await pending).toBeNull()
	})

	it("parses a JSON body on success, and treats an empty 204 as success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })),
		)
		expect(await postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall" })).toEqual({
			results: [],
		})

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 204 })),
		)
		// A delete that succeeded must not read as a failure just because it has no body.
		expect(await deleteHindsight(ENDPOINT, "/v1/doc", { operation: "purge" })).toBe(true)
	})

	it("opens the breaker after repeated failures and stops calling out", async () => {
		const fetchSpy = vi.fn(async () => new Response("down", { status: 503 }))
		vi.stubGlobal("fetch", fetchSpy)
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall" })
		}
		expect(hindsightBreakerState(ENDPOINT.baseUrl).open).toBe(true)
		const callsBefore = fetchSpy.mock.calls.length

		// The fourth call must not pay the timeout: a dead dependency cannot add its
		// latency to every request.
		expect(await postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall" })).toBeNull()
		expect(fetchSpy.mock.calls.length).toBe(callsBefore)
	})

	it("closes the breaker again after a success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("down", { status: 503 })),
		)
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall" })
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
		)
		// One probe is allowed through once the cooldown lapses.
		vi.useFakeTimers()
		await vi.advanceTimersByTimeAsync(31_000)
		await postHindsight(ENDPOINT, "/v1/x", {}, { operation: "recall" })
		expect(hindsightBreakerState(ENDPOINT.baseUrl).open).toBe(false)
	})
})
