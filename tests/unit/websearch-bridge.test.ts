/**
 * Web search bridge — Anthropic block construction, and the non-streaming
 * attachment that splices them into a Claude response.
 */
import { describe, expect, it, vi } from "vitest"
import {
	MAX_RESULTS_CEILING,
	RESULT_ERROR_UNAVAILABLE,
	SERVER_TOOL_USE_BLOCK,
	SERVER_TOOL_USE_ID_RE,
	WEB_SEARCH_RESULT_BLOCK,
	WEB_SEARCH_RESULT_ITEM,
} from "../../apps/web/open-sse/config/webSearchConstants.js"
import {
	attachWebSearchToClaudeBody,
	findWebSearchCall,
	hasUpstreamSearch,
} from "../../apps/web/open-sse/handlers/webSearchBody.js"
import {
	buildSearchBlocks,
	buildSearchErrorBlocks,
	searchFailureNotice,
	toResultContent,
} from "../../apps/web/open-sse/handlers/webSearchBridge.js"

const unifiedResult = (over = {}) => ({
	title: "Doc page",
	url: "https://docs.example.com/guide",
	snippet: "how to do the thing",
	published_at: "2026-01-02T00:00:00.000Z",
	...over,
})

const bridgePlan = (over = {}) => ({
	active: true,
	lane: "bridge",
	maxUses: 5,
	defaultMaxResults: 5,
	allowedDomains: [],
	blockedDomains: [],
	...over,
})

describe("result mapping", () => {
	it("maps a unified result to an Anthropic result item", () => {
		const [item] = toResultContent([unifiedResult()])
		expect(item.type).toBe(WEB_SEARCH_RESULT_ITEM)
		expect(item.title).toBe("Doc page")
		expect(item.url).toBe("https://docs.example.com/guide")
		expect(item.page_age).toBe("2026-01-02T00:00:00.000Z")
	})

	it("carries the snippet in encrypted_content so the block round-trips", () => {
		// Anthropic clients echo encrypted_content back on later turns to keep
		// citations resolvable. 9router both writes and reads the field, so
		// carrying the real snippet round-trips the cited text instead of
		// dropping it. It is NOT an encrypted blob and is not presented as one:
		// 9router has no upstream cipher, so there is nothing to decrypt — the
		// value is the plaintext the search engine actually returned.
		const [item] = toResultContent([unifiedResult()])
		expect(item).toHaveProperty("encrypted_content")
		expect(item.encrypted_content).toBe(unifiedResult().snippet)
	})

	it("never invents content for encrypted_content when there is no snippet", () => {
		const [item] = toResultContent([unifiedResult({ snippet: null })])
		// Empty, not a fabricated token — an invented value would be worse than an
		// honest gap, because the client cannot tell the difference.
		expect(item.encrypted_content).toBe("")
	})

	it("omits page_age when the engine has no date", () => {
		const [item] = toResultContent([unifiedResult({ published_at: null })])
		expect(item).not.toHaveProperty("page_age")
	})

	it("drops results with no url — an uncitable result is not a result", () => {
		expect(toResultContent([unifiedResult({ url: "" })])).toHaveLength(0)
	})

	it("caps the result list", () => {
		const many = Array.from({ length: 50 }, (_, i) => unifiedResult({ url: `https://e.test/${i}` }))
		expect(toResultContent(many).length).toBeLessThanOrEqual(MAX_RESULTS_CEILING)
	})

	it("tolerates junk input", () => {
		expect(toResultContent(null)).toEqual([])
		expect(toResultContent([null, undefined])).toEqual([])
	})
})

describe("buildSearchBlocks", () => {
	it("pairs both blocks to the supplied id", () => {
		const { serverToolUse, toolResult } = buildSearchBlocks({
			query: "how to test",
			toolUseId: "srvtoolu_abc123",
			results: [unifiedResult()],
		})

		expect(serverToolUse.type).toBe(SERVER_TOOL_USE_BLOCK)
		expect(serverToolUse.id).toBe("srvtoolu_abc123")
		expect(serverToolUse.name).toBe("web_search")
		expect(serverToolUse.input.query).toBe("how to test")

		expect(toolResult.type).toBe(WEB_SEARCH_RESULT_BLOCK)
		expect(toolResult.tool_use_id).toBe("srvtoolu_abc123")
		expect(toolResult.content).toHaveLength(1)
	})

	it("generates a client-acceptable id when the model used its own", () => {
		const { serverToolUse } = buildSearchBlocks({ query: "q", results: [] })
		expect(serverToolUse.id).toMatch(SERVER_TOOL_USE_ID_RE)
	})

	it("emits an empty but well-formed result for a successful empty search", () => {
		const { toolResult } = buildSearchBlocks({ query: "q", results: [] })
		expect(toolResult.content).toEqual([])
		expect(toolResult).not.toHaveProperty("error_code")
	})

	it("carries only Anthropic-defined error codes", () => {
		const { toolResult } = buildSearchErrorBlocks({
			query: "q",
			toolUseId: "srvtoolu_x",
			errorCode: RESULT_ERROR_UNAVAILABLE,
			message: "boom",
		})
		expect(toolResult.error_code).toBe(RESULT_ERROR_UNAVAILABLE)
		expect(toolResult.error_message).toBe("boom")
		expect(toolResult.content).toEqual([])
	})

	it("writes a readable failure notice", () => {
		expect(searchFailureNotice("provider down")).toContain("provider down")
	})
})

describe("attachWebSearchToClaudeBody", () => {
	const callResponse = (over = {}) => ({
		type: "message",
		role: "assistant",
		content: [
			{ type: "text", text: "Let me check." },
			{ type: "tool_use", id: "toolu_model_1", name: "web_search", input: { query: "how to test" } },
		],
		...over,
	})

	it("replaces the function call with the Anthropic block pair", async () => {
		const runSearch = vi.fn().mockResolvedValue([unifiedResult()])
		const body = callResponse()

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(runSearch).toHaveBeenCalledOnce()
		expect(runSearch.mock.calls[0][0].query).toBe("how to test")

		const kinds = body.content.map((b) => b.type)
		// The function call is gone; the server pair replaced it.
		expect(kinds).not.toContain("tool_use")
		expect(kinds).toEqual(["text", SERVER_TOOL_USE_BLOCK, WEB_SEARCH_RESULT_BLOCK])
	})

	it("keeps both halves paired to one id the client accepts", async () => {
		const runSearch = vi.fn().mockResolvedValue([unifiedResult()])
		const body = callResponse()

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		const serverToolUse = body.content.find((b) => b.type === SERVER_TOOL_USE_BLOCK)
		const toolResult = body.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)

		// The model emitted toolu_*, which Anthropic rejects — it must be normalized.
		expect(serverToolUse.id).toMatch(SERVER_TOOL_USE_ID_RE)
		expect(toolResult.tool_use_id).toBe(serverToolUse.id)
	})

	it("splices the blocks where the call was, so citations stay next to the text", async () => {
		const runSearch = vi.fn().mockResolvedValue([unifiedResult()])
		const body = callResponse()

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(body.content[0].type).toBe("text")
		expect(body.content[1].type).toBe(SERVER_TOOL_USE_BLOCK)
	})

	it("emits an error block when the search throws — never leaves the call dangling", async () => {
		const runSearch = vi.fn().mockRejectedValue(new Error("serper 500"))
		const body = callResponse()

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(body.content.some((b) => b.type === "tool_use")).toBe(false)
		const toolResult = body.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)
		expect(toolResult.error_code).toBe(RESULT_ERROR_UNAVAILABLE)
		// Still paired — an unpaired result would hang the client.
		expect(toolResult.tool_use_id).toMatch(SERVER_TOOL_USE_ID_RE)
	})

	it("adds no blocks when the model never called the tool", async () => {
		const runSearch = vi.fn()
		const body = { type: "message", content: [{ type: "text", text: "I know this." }] }

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(runSearch).not.toHaveBeenCalled()
		expect(body.content).toHaveLength(1)
	})

	it("does not duplicate blocks the upstream already produced", async () => {
		const runSearch = vi.fn()
		const body = {
			type: "message",
			content: [
				{ type: SERVER_TOOL_USE_BLOCK, id: "srvtoolu_up", name: "web_search", input: { query: "q" } },
				{ type: WEB_SEARCH_RESULT_BLOCK, tool_use_id: "srvtoolu_up", content: [] },
				{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } },
			],
		}

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(runSearch).not.toHaveBeenCalled()
		expect(hasUpstreamSearch(body.content)).toBe(true)
	})

	it("does nothing on the passthrough lane", async () => {
		const runSearch = vi.fn()
		const body = callResponse()

		await attachWebSearchToClaudeBody({
			responseBody: body,
			webSearchPlan: bridgePlan({ lane: "passthrough" }),
			runSearch,
		})

		expect(runSearch).not.toHaveBeenCalled()
		expect(findWebSearchCall(body.content)).toBeTruthy()
	})

	it("rejects a call with no query instead of searching for nothing", async () => {
		const runSearch = vi.fn()
		const body = {
			type: "message",
			content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: {} }],
		}

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(runSearch).not.toHaveBeenCalled()
		const toolResult = body.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)
		expect(toolResult).toBeTruthy()
	})

	it("handles the search call being the only content", async () => {
		const runSearch = vi.fn().mockResolvedValue([unifiedResult()])
		const body = {
			type: "message",
			content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }],
		}

		await attachWebSearchToClaudeBody({ responseBody: body, webSearchPlan: bridgePlan(), runSearch })

		expect(body.content.map((b) => b.type)).toEqual([SERVER_TOOL_USE_BLOCK, WEB_SEARCH_RESULT_BLOCK])
	})

	it("is a no-op on an inactive plan", async () => {
		const runSearch = vi.fn()
		const body = callResponse()

		await attachWebSearchToClaudeBody({
			responseBody: body,
			webSearchPlan: { active: false, lane: "none" },
			runSearch,
		})

		expect(runSearch).not.toHaveBeenCalled()
		expect(body.content).toHaveLength(2)
	})
})
