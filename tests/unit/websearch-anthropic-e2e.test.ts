/**
 * Web search over the Anthropic protocol — end-to-end contract.
 *
 * Claude Code declares `web_search_20250910` and expects Anthropic's exact
 * block pair back. This exercises the pieces together on a Claude-protocol
 * request: the lane decision, the bridge tool swap in provider format, and the
 * block pair a real client would parse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { handleSearchCoreMock } = vi.hoisted(() => ({ handleSearchCoreMock: vi.fn() }))
vi.mock("../../apps/web/open-sse/handlers/search/index.js", () => ({
	handleSearchCore: (...args) => handleSearchCoreMock(...args),
}))

import {
	SERVER_TOOL_USE_BLOCK,
	WEB_SEARCH_RESULT_BLOCK,
	WEB_SEARCH_TOOL_NAME,
	WEB_SEARCH_TOOL_TYPE,
} from "../../apps/web/open-sse/config/webSearchConstants.js"
import {
	attachWebSearchToClaudeBody,
	findWebSearchCall,
} from "../../apps/web/open-sse/handlers/webSearchBody.js"
import { resolveSearchProvider } from "../../apps/web/open-sse/handlers/webSearchCredentials.js"
import {
	installBridgeTool,
	isClaudeTargetFormat,
	resolveWebSearchPlan,
} from "../../apps/web/open-sse/handlers/webSearchProtocol.js"

/** The body Claude Code actually sends when web search is on. */
function claudeCodeRequest(overrides = {}) {
	return {
		model: "claude-sonnet-4-6",
		max_tokens: 1024,
		messages: [{ role: "user", content: "What is the latest news about AI?" }],
		tools: [
			{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: 5 },
			{ name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } },
		],
		...overrides,
	}
}

/** The provider body after translation to a non-search provider (openai). */
function translatedOpenAIBody() {
	return {
		model: "gpt-4o",
		messages: [{ role: "user", content: "What is the latest news about AI?" }],
		tools: [
			// A real translation leaves a web_search entry here; installBridgeTool
			// must replace it with a bridge declaration the provider can call.
			{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: 5 },
		],
	}
}

const searchResults = [
	{
		title: "AI news roundup",
		url: "https://news.example.com/ai",
		snippet: "Lots of AI news.",
		published_at: "October 10, 2026",
	},
	{
		title: "Anthropic ships X",
		url: "https://news.example.com/x",
		snippet: "New thing.",
		published_at: null,
	},
]

let runSearch
beforeEach(() => {
	handleSearchCoreMock.mockReset()
	handleSearchCoreMock.mockResolvedValue({ success: true, data: { results: searchResults } })
	runSearch = vi.fn().mockResolvedValue(searchResults)
})

describe("Claude Code web search, end to end", () => {
	it("activates on a Claude request that declares the server tool", () => {
		const plan = resolveWebSearchPlan({
			body: claudeCodeRequest(),
			translatedBody: translatedOpenAIBody(),
			provider: "openai",
			settings: {},
		})

		expect(plan.active).toBe(true)
		expect(plan.lane).toBe("bridge")
		expect(plan.maxUses).toBe(5)
	})

	it("stays inactive for a request with no web search tool", () => {
		const plan = resolveWebSearchPlan({
			body: claudeCodeRequest({ tools: [{ name: "Read" }] }),
			translatedBody: translatedOpenAIBody(),
			provider: "openai",
			settings: {},
		})
		expect(plan.active).toBe(false)
	})

	it("swaps the server tool for a bridge tool the provider accepts", () => {
		const body = claudeCodeRequest()
		const translated = translatedOpenAIBody()
		const plan = resolveWebSearchPlan({
			body,
			translatedBody: translated,
			provider: "openai",
			settings: {},
		})

		installBridgeTool(translated, plan, "openai")

		// The upstream must never see the Anthropic server tool: it has no
		// web_search backend of its own on this lane.
		expect(translated.tools.some((t) => t.type === WEB_SEARCH_TOOL_TYPE)).toBe(false)
		// ...and it gets a callable function tool it can actually invoke.
		const bridge = translated.tools.find((t) => t.function?.name === WEB_SEARCH_TOOL_NAME)
		expect(bridge).toBeTruthy()
		// A function tool with no required list invites the model to call it with
		// no query, which would produce a query-less search.
		expect(bridge.function.parameters.required).toEqual(["query"])
		expect(bridge.function.parameters.properties.query).toBeTruthy()
	})

	it("returns the Anthropic block pair Claude Code parses", async () => {
		const upstreamResponse = {
			content: [
				{ type: "text", text: "Let me look that up." },
				{
					type: "tool_use",
					id: "toolu_01ABC",
					name: WEB_SEARCH_TOOL_NAME,
					input: { query: "latest AI news" },
				},
			],
		}

		const result = await attachWebSearchToClaudeBody({
			responseBody: upstreamResponse,
			webSearchPlan: { active: true, lane: "bridge", maxUses: 5 },
			runSearch,
		})

		const serverUse = result.content.find((b) => b.type === SERVER_TOOL_USE_BLOCK)
		const toolResult = result.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)

		expect(serverUse).toBeTruthy()
		expect(toolResult).toBeTruthy()
		// The pair must be linked by id, or the client cannot match them.
		expect(toolResult.tool_use_id).toBe(serverUse.id)
		expect(serverUse.input.query).toBe("latest AI news")
		// The original model text must survive verbatim.
		expect(result.content[0]).toEqual({ type: "text", text: "Let me look that up." })
	})

	it("searches the query the model actually asked", async () => {
		const responseBody = {
			content: [
				{
					type: "tool_use",
					id: "toolu_1",
					name: WEB_SEARCH_TOOL_NAME,
					input: { query: "AI regulation 2026" },
				},
			],
		}
		await attachWebSearchToClaudeBody({
			responseBody,
			webSearchPlan: { active: true, lane: "bridge", maxUses: 5 },
			runSearch,
		})

		expect(runSearch).toHaveBeenCalledOnce()
		expect(runSearch.mock.calls[0][0].query).toBe("AI regulation 2026")
	})

	it("surfaces the search results as citable Anthropic result items", async () => {
		const responseBody = {
			content: [
				{ type: "tool_use", id: "toolu_1", name: WEB_SEARCH_TOOL_NAME, input: { query: "q" } },
			],
		}
		const result = await attachWebSearchToClaudeBody({
			responseBody,
			webSearchPlan: { active: true, lane: "bridge", maxUses: 5 },
			runSearch,
		})

		const toolResult = result.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)
		expect(toolResult.content).toHaveLength(2)
		expect(toolResult.content[0]).toMatchObject({
			type: "web_search_result",
			title: "AI news roundup",
			url: "https://news.example.com/ai",
		})
		expect(toolResult.content[0].page_age).toBe("October 10, 2026")
	})

	it("leaves a response with no search call completely alone", async () => {
		const responseBody = { content: [{ type: "text", text: "I know this one." }] }
		const result = await attachWebSearchToClaudeBody({
			responseBody,
			webSearchPlan: { active: true, lane: "bridge", maxUses: 5 },
			runSearch,
		})

		expect(runSearch).not.toHaveBeenCalled()
		expect(result.content).toEqual([{ type: "text", text: "I know this one." }])
	})

	it("does not double-answer a call the upstream already resolved", async () => {
		// On the passthrough lane the upstream ran the search itself and streamed
		// both blocks; re-running it would duplicate the results in the context.
		const responseBody = {
			content: [
				{
					type: SERVER_TOOL_USE_BLOCK,
					id: "srvtoolu_up",
					name: WEB_SEARCH_TOOL_NAME,
					input: { query: "q" },
				},
				{ type: WEB_SEARCH_RESULT_BLOCK, tool_use_id: "srvtoolu_up", content: [] },
			],
		}
		const result = await attachWebSearchToClaudeBody({
			responseBody,
			webSearchPlan: { active: true, lane: "bridge", maxUses: 5 },
			runSearch,
		})

		expect(runSearch).not.toHaveBeenCalled()
		expect(result.content.filter((b) => b.type === WEB_SEARCH_RESULT_BLOCK)).toHaveLength(1)
	})

	it("emits an Anthropic-legal error block when the search engine fails", async () => {
		runSearch.mockRejectedValue(new Error("serper 500"))
		const responseBody = {
			content: [
				{ type: "tool_use", id: "toolu_1", name: WEB_SEARCH_TOOL_NAME, input: { query: "q" } },
			],
		}
		const result = await attachWebSearchToClaudeBody({
			responseBody,
			webSearchPlan: { active: true, lane: "bridge", maxUses: 5 },
			runSearch,
		})

		const toolResult = result.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)
		// error_code must be an Anthropic-defined value — the client renders it
		// verbatim, so an invented code reads to the user as a 9router bug.
		expect(["max_uses_exceeded", "too_many_requests", "unavailable"]).toContain(toolResult.error_code)
	})

	it("honours the off switch even when the client asks for search", () => {
		const plan = resolveWebSearchPlan({
			body: claudeCodeRequest(),
			translatedBody: translatedOpenAIBody(),
			provider: "openai",
			settings: { webSearchEnabled: false },
		})
		expect(plan.active).toBe(false)
	})

	it("auto-activates when the setting is unset", () => {
		const plan = resolveWebSearchPlan({
			body: claudeCodeRequest(),
			translatedBody: translatedOpenAIBody(),
			provider: "openai",
			settings: { webSearchEnabled: null },
		})
		expect(plan.active).toBe(true)
	})

	it("uses passthrough when the upstream runs web search itself", () => {
		const plan = resolveWebSearchPlan({
			body: claudeCodeRequest(),
			translatedBody: { tools: [] },
			provider: "anthropic",
			settings: {},
		})
		expect(plan.lane).toBe("passthrough")
		// Passthrough must leave tools untouched: the upstream needs the real
		// Anthropic server tool to execute the search itself.
		const translated = { tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME }] }
		installBridgeTool(translated, plan, "claude")
		expect(translated.tools).toHaveLength(1)
	})

	it("prefers a connected search provider over the chat lane's provider", () => {
		// `openai` advertises searchViaChat, but that model has no search access
		// and the account may not even be connected. A provider in `candidates`
		// has live credentials by construction, so it wins.
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "openai",
			candidates: ["serper"],
		})
		expect(sel.providerId).toBe("serper")
		expect(sel.source).toBe("auto")
	})

	it("falls back to the chat provider when nothing else is connected", () => {
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "kiro",
			candidates: [],
		})
		expect(sel.providerId).toBeNull()
		const fallback = resolveSearchProvider({
			providerId: null,
			requestProvider: "openai",
			candidates: [],
		})
		expect(fallback.providerId).toBe("openai")
		expect(fallback.source).toBe("request-provider")
	})

	it("finds the call in a Claude content array", () => {
		const call = findWebSearchCall([
			{ type: "text", text: "hi" },
			{ type: "tool_use", id: "toolu_1", name: WEB_SEARCH_TOOL_NAME, input: { query: "q" } },
		])
		expect(call.id).toBe("toolu_1")
	})

	it("uses the claude wire shape for a claude-format provider body", () => {
		const body = claudeCodeRequest()
		const plan = resolveWebSearchPlan({
			body,
			translatedBody: body,
			provider: "anthropic",
			settings: {},
		})
		expect(plan.lane).toBe("passthrough")
		expect(isClaudeTargetFormat("claude")).toBe(true)
	})
})
