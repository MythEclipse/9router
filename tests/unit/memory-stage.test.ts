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
import {
	lastUserQuery,
	plainMessages,
	stripMemoryBlock,
	textOf,
} from "../../apps/web/src/lib/memory/transcript"

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

describe("memory config: off by default, on per scope", () => {
	it("is off when nothing opted in — no global switch exists", () => {
		// A settings row with connection details but no opt-in runs nothing. There is
		// deliberately no `memory.enabled` here to fall back on.
		const config = resolveMemoryConfig({
			settings: { memory: { baseUrl: "http://h:8888", bankId: "shared" } },
		})
		expect(config.enabled).toBe(false)
	})

	it("does not read a global enabled flag even if one is present", () => {
		// Guards the migration: an old row that still carries `enabled: true` must not
		// switch the stage on for every caller of the gateway.
		const config = resolveMemoryConfig({
			settings: { memory: { enabled: true, baseUrl: "http://h:8888" } },
		})
		expect(config.enabled).toBe(false)
	})

	it("turns on for a key that opted in, even with no combo", () => {
		const config = resolveMemoryConfig({
			settings: { memory: { baseUrl: "http://h:8888", bankId: "shared" } },
			keyOptedIn: true,
		})
		expect(config.enabled).toBe(true)
		expect(config.bankId).toBe("shared")
	})

	it("turns on for a combo that opted in, even with no key opt-in", () => {
		const config = resolveMemoryConfig({
			settings: {
				memory: { bankId: "shared" },
				comboStrategies: { public: { memory: { enabled: true, includeShared: false } } },
			},
			comboName: "public",
		})
		expect(config.enabled).toBe(true)
		expect(config.includeShared).toBe(false)
	})

	it("leaves a different combo off", () => {
		const config = resolveMemoryConfig({
			settings: {
				comboStrategies: { public: { memory: { enabled: true } } },
			},
			comboName: "private",
		})
		expect(config.enabled).toBe(false)
	})

	it("lets a combo retune an enabled stage", () => {
		const config = resolveMemoryConfig({
			settings: {
				memory: { recallMaxTokens: 1200 },
				comboStrategies: { public: { memory: { enabled: true, recallMaxTokens: 300 } } },
			},
			comboName: "public",
		})
		expect(config.recallMaxTokens).toBe(300)
	})

	it("does not let a combo's knobs leak into a request it does not cover", () => {
		const config = resolveMemoryConfig({
			settings: {
				memory: { recallMaxTokens: 1200 },
				comboStrategies: { public: { memory: { enabled: true, recallMaxTokens: 300 } } },
			},
			comboName: "private",
			keyOptedIn: true,
		})
		expect(config.enabled).toBe(true)
		// The key opted in, but the combo block belongs to another combo.
		expect(config.recallMaxTokens).toBe(1200)
	})

	it("turns on for a trusted caller such as the dashboard", () => {
		const config = resolveMemoryConfig({ settings: {}, trustedCaller: true })
		expect(config.enabled).toBe(true)
	})
})

describe("recall output must not be retained back into the bank", () => {
	// Recall injects <memory>…</memory> into the body and retain reads that same
	// body, so an unstripped block is written back on every turn. Measured on a
	// live document: 5,875 chars, nearly all of it the block, for a two-turn chat.
	const block = [
		"<memory>",
		"The following notes were recalled from a persistent memory store.",
		"",
		"- [world] The user deploys 9router via CI on push to master.",
		"</memory>",
	].join("\n")

	it("strips an injected block but keeps the caller's own words", () => {
		const text = `system (2026-11-19T10:34:57Z): ${block}\nuser (2026-11-19T10:34:57Z): halo`
		const clean = stripMemoryBlock(text)
		expect(clean).not.toContain("<memory>")
		expect(clean).not.toContain("deploys 9router via CI")
		expect(clean).toContain("halo")
	})

	it("strips a block that was cut off mid-stream", () => {
		// An aborted request can leave the closing tag missing; the text after it
		// never existed, so dropping the tail is the whole fix.
		const clean = stripMemoryBlock(`system: <memory>\n- [world] partial fact`)
		expect(clean).toBe("system:")
	})

	it("leaves ordinary text untouched", () => {
		expect(stripMemoryBlock("just a normal message")).toBe("just a normal message")
		expect(stripMemoryBlock("")).toBe("")
	})

	it("plainMessages drops the block before retain can read it", () => {
		const messages = plainMessages({
			messages: [
				{ role: "system", content: block },
				{ role: "user", content: "pertanyaan saya" },
			],
		})
		// The system turn was nothing but memory: it disappears entirely rather than
		// being retained as an empty line.
		expect(messages).toHaveLength(1)
		expect(messages[0]).toEqual({ role: "user", text: "pertanyaan saya" })
	})
})

describe("dashboard switches keep what they do not own", () => {
	it("turning a combo off removes only the enabled flag", () => {
		// A combo may carry includeShared/budget tuning it will use again; a toggle
		// that dropped the whole block would silently lose it.
		const settings = {
			comboStrategies: {
				public: { memory: { enabled: true, includeShared: false, recallMaxTokens: 300 } },
			},
		}
		const strategies = settings.comboStrategies
		const current = strategies.public as Record<string, unknown>
		const nextMemory = { ...((current.memory ?? {}) as Record<string, unknown>) }
		delete nextMemory.enabled

		expect(nextMemory).toEqual({ includeShared: false, recallMaxTokens: 300 })
		// And with `enabled` gone the combo resolves off again.
		const config = resolveMemoryConfig({
			settings: {
				comboStrategies: { public: { ...current, memory: nextMemory } },
			},
			comboName: "public",
		})
		expect(config.enabled).toBe(false)
	})

	it("keeps the stored token when the form submits a blank one", () => {
		// The dashboard cannot read the token back, so an unrelated save would
		// otherwise clear it — the same trap the OIDC secret has.
		const patch: Record<string, unknown> = { apiKey: "", bankId: "shared" }
		const next: Record<string, unknown> = { apiKey: "secret", bankId: "old" }
		if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey
		if (typeof patch.bankId === "string") next.bankId = patch.bankId
		expect(next.apiKey).toBe("secret")
		expect(next.bankId).toBe("shared")
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
