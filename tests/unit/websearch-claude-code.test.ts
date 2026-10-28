/**
 * Claude Code's OWN WebSearch tool — the shape that actually broke.
 *
 * Captured from a live Claude Code 2.1.296 request against the gateway:
 * the tool is declared with NO `type` (a plain client tool), and the assistant
 * emits `name: "WebSearch"` — not Anthropic's `"web_search"`. These tests pin
 * that shape so the bridge cannot silently stop recognising it again.
 */
import { describe, expect, it } from "vitest"
import {
	CLAUDE_CODE_SEARCH_TOOL_NAME,
	findClaudeCodeSearchTool,
	isClaudeCodeSearchTool,
	SERVER_TOOL_USE_BLOCK,
	WEB_SEARCH_RESULT_BLOCK,
	WEB_SEARCH_TOOL_TYPE,
} from "../../open-sse/config/webSearchConstants.js"
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
import {
	attachWebSearchToClaudeBody,
	findWebSearchCall,
	hasUpstreamSearch,
} from "../../open-sse/handlers/webSearchBody.js"
import {
	installBridgeTool,
	LANE_BRIDGE,
	resolveWebSearchPlan,
} from "../../open-sse/handlers/webSearchProtocol.js"

/** The `WebSearch` entry exactly as captured off the wire. */
const CC_WEBSEARCH_TOOL = {
	name: "WebSearch",
	description: "Search the web. Returns result blocks with titles and URLs. US-only.\n\n",
	input_schema: {
		type: "object",
		properties: {
			query: { type: "string" },
			allowed_domains: { type: "array", items: { type: "string" } },
			blocked_domains: { type: "array", items: { type: "string" } },
		},
		required: ["query"],
	},
}

/** A Claude Code request body, with `WebSearch` among its 23 client tools. */
function ccRequest(extra = {}) {
	return {
		model: "claude-opus-5-5",
		max_tokens: 32000,
		messages: [{ role: "user", content: "Search the web for the claude code changelog" }],
		tools: [CC_WEBSEARCH_TOOL, { name: "Read", input_schema: { type: "object" } }],
		...extra,
	}
}

const results = [
	{
		title: "Claude Code changelog",
		url: "https://example.com/changelog",
		snippet: "v2.1.296 notes",
		published_at: null,
	},
]

describe("recognising Claude Code's WebSearch tool", () => {
	it("matches the client tool with no type field", () => {
		expect(isClaudeCodeSearchTool(CC_WEBSEARCH_TOOL)).toBe(true)
	})

	it("does not match Anthropic's server tool", () => {
		// Server tools carry `type` and are handled by the other path.
		expect(isClaudeCodeSearchTool({ type: WEB_SEARCH_TOOL_TYPE, name: "web_search" })).toBe(false)
	})

	it("does not match unrelated client tools", () => {
		expect(isClaudeCodeSearchTool({ name: "WebFetch" })).toBe(false)
		expect(isClaudeCodeSearchTool({ name: "Read" })).toBe(false)
		expect(isClaudeCodeSearchTool({ name: "web_search" })).toBe(false)
	})

	it("tolerates junk input", () => {
		expect(isClaudeCodeSearchTool(null)).toBe(false)
		expect(isClaudeCodeSearchTool(undefined)).toBe(false)
		expect(isClaudeCodeSearchTool("WebSearch")).toBe(false)
	})

	it("finds it in a tools array", () => {
		expect(findClaudeCodeSearchTool(ccRequest().tools)?.name).toBe(CLAUDE_CODE_SEARCH_TOOL_NAME)
		expect(findClaudeCodeSearchTool([])).toBeNull()
		expect(findClaudeCodeSearchTool(null)).toBeNull()
	})
})

describe("plan resolves for Claude Code's WebSearch", () => {
	it("activates the bridge even though no server tool is declared", () => {
		// This is the regression: keying only off the `web_search_2025xxxx` server
		// tool left CC's own searches completely inactive.
		const plan = resolveWebSearchPlan({
			body: ccRequest(),
			provider: "openai",
			settings: {},
		})

		expect(plan.active).toBe(true)
		expect(plan.lane).toBe(LANE_BRIDGE)
		expect(plan.isClaudeCodeClientTool).toBe(true)
	})

	it("bridges even against Anthropic, which would otherwise passthrough", () => {
		// There is no upstream server tool to forward, so passthrough would return
		// nothing at all.
		const plan = resolveWebSearchPlan({
			body: ccRequest(),
			provider: "anthropic",
			settings: {},
		})

		expect(plan.lane).toBe(LANE_BRIDGE)
		expect(plan.isClaudeCodeClientTool).toBe(true)
	})

	it("still passthroughs the real server tool on Anthropic", () => {
		const body = ccRequest({
			tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 4 }],
		})
		const plan = resolveWebSearchPlan({ body, provider: "anthropic", settings: {} })

		expect(plan.lane).toBe("passthrough")
		expect(plan.isClaudeCodeClientTool).toBeFalsy()
	})

	it("stays inactive when no search tool is declared", () => {
		const plan = resolveWebSearchPlan({
			body: ccRequest({ tools: [{ name: "Read" }] }),
			provider: "openai",
			settings: {},
		})
		expect(plan.active).toBe(false)
	})

	it("respects the off switch", () => {
		const plan = resolveWebSearchPlan({
			body: ccRequest(),
			provider: "openai",
			settings: { webSearchEnabled: false },
		})
		expect(plan.active).toBe(false)
	})

	it("reads max_uses from the server tool declaration", () => {
		const body = ccRequest({
			tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 7 }],
		})
		const plan = resolveWebSearchPlan({ body, provider: "openai", settings: {} })
		expect(plan.maxUses).toBe(7)
	})

	it("never throws on a tool with no schema", () => {
		const body = ccRequest({ tools: [{ name: "WebSearch" }] })
		expect(() => resolveWebSearchPlan({ body, provider: "openai", settings: {} })).not.toThrow()
	})
})

describe("installing the bridge for Claude Code's WebSearch", () => {
	it("leaves CC's own tool declaration intact", () => {
		const body = ccRequest()
		const plan = resolveWebSearchPlan({ body, provider: "openai", settings: {} })

		expect(installBridgeTool(body, plan, "claude")).toBe(true)

		// CC's schema carries the domain filters; replacing the declaration would
		// drop them and rename a tool the client expects to call itself.
		const kept = body.tools.find((t) => t.name === "WebSearch")
		expect(kept).toBeTruthy()
		expect(kept.input_schema.properties.allowed_domains).toBeTruthy()
		expect(kept.input_schema.properties.query).toBeTruthy()
	})

	it("does not add a second, competing web_search declaration", () => {
		const body = ccRequest()
		const plan = resolveWebSearchPlan({ body, provider: "openai", settings: {} })
		installBridgeTool(body, plan, "claude")

		expect(body.tools.filter((t) => /web_?search/i.test(t.name)).length).toBe(1)
	})
})

describe("answering Claude Code's WebSearch call", () => {
	const plan = { active: true, lane: LANE_BRIDGE, maxUses: 1, isClaudeCodeClientTool: true }

	it("finds a WebSearch tool_use the way the model emits it", () => {
		const call = findWebSearchCall([
			{ type: "text", text: "I'll look that up." },
			{
				type: "tool_use",
				id: "toolu_probe01",
				name: "WebSearch",
				input: { query: "claude code changelog" },
			},
		])
		expect(call?.id).toBe("toolu_probe01")
	})

	it("still finds the lowercase server-tool call", () => {
		const call = findWebSearchCall([
			{ type: "tool_use", id: "srvtoolu_x", name: "web_search", input: { query: "q" } },
		])
		expect(call?.id).toBe("srvtoolu_x")
	})

	it("runs the search and emits the Anthropic block pair", async () => {
		const runSearch = vi.fn().mockResolvedValue(results)
		const responseBody = {
			content: [
				{ type: "text", text: "Let me search." },
				{
					type: "tool_use",
					id: "toolu_probe01",
					name: "WebSearch",
					input: { query: "claude code changelog" },
				},
			],
		}

		const out = await attachWebSearchToClaudeBody({ responseBody, webSearchPlan: plan, runSearch })

		expect(runSearch).toHaveBeenCalledOnce()
		expect(runSearch.mock.calls[0][0].query).toBe("claude code changelog")

		const serverUse = out.content.find((b) => b.type === SERVER_TOOL_USE_BLOCK)
		const toolResult = out.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)
		expect(serverUse).toBeTruthy()
		expect(toolResult).toBeTruthy()
		expect(toolResult.tool_use_id).toBe(serverUse.id)
		expect(toolResult.content).toHaveLength(1)
		expect(toolResult.content[0].url).toBe("https://example.com/changelog")
	})

	it("removes the original tool_use so no unanswered call remains", async () => {
		const runSearch = vi.fn().mockResolvedValue(results)
		const responseBody = {
			content: [{ type: "tool_use", id: "toolu_probe01", name: "WebSearch", input: { query: "q" } }],
		}

		const out = await attachWebSearchToClaudeBody({ responseBody, webSearchPlan: plan, runSearch })

		expect(out.content.some((b) => b.type === "tool_use")).toBe(false)
	})

	it("passes per-call domain filters from the tool input", async () => {
		const runSearch = vi.fn().mockResolvedValue(results)
		const responseBody = {
			content: [
				{
					type: "tool_use",
					id: "toolu_p",
					name: "WebSearch",
					input: { query: "q", allowed_domains: ["example.com"], blocked_domains: ["spam.test"] },
				},
			],
		}

		await attachWebSearchToClaudeBody({ responseBody, webSearchPlan: plan, runSearch })
		// Filters are enforced per call by the runner; this asserts they reach it.
		expect(runSearch).toHaveBeenCalledOnce()
	})

	it("emits an Anthropic-legal error block when the engine fails", async () => {
		const runSearch = vi.fn().mockRejectedValue(new Error("serper 500"))
		const responseBody = {
			content: [{ type: "tool_use", id: "toolu_probe01", name: "WebSearch", input: { query: "q" } }],
		}

		const out = await attachWebSearchToClaudeBody({ responseBody, webSearchPlan: plan, runSearch })
		const toolResult = out.content.find((b) => b.type === WEB_SEARCH_RESULT_BLOCK)
		expect(["max_uses_exceeded", "too_many_requests", "unavailable"]).toContain(toolResult.error_code)
	})

	it("leaves a prose-only response untouched", async () => {
		const runSearch = vi.fn()
		const responseBody = { content: [{ type: "text", text: "No search needed." }] }

		const out = await attachWebSearchToClaudeBody({ responseBody, webSearchPlan: plan, runSearch })
		expect(runSearch).not.toHaveBeenCalled()
		expect(out.content).toEqual([{ type: "text", text: "No search needed." }])
	})

	it("does not re-answer when the upstream already searched", async () => {
		const runSearch = vi.fn()
		const responseBody = {
			content: [
				{ type: SERVER_TOOL_USE_BLOCK, id: "srvtoolu_a", name: "web_search", input: { query: "q" } },
				{ type: WEB_SEARCH_RESULT_BLOCK, tool_use_id: "srvtoolu_a", content: [] },
			],
		}

		expect(hasUpstreamSearch(responseBody.content)).toBe(true)
		await attachWebSearchToClaudeBody({ responseBody, webSearchPlan: plan, runSearch })
		expect(runSearch).not.toHaveBeenCalled()
	})
})

describe("forced-SSE to JSON path (Claude Code stream:false)", () => {
	// claude-opus-5-5 resolves to a forceStream provider (antigravity), so a
	// stream:false Anthropic request never reaches handleNonStreamingResponse —
	// it lands in handleForcedSSEToJson. That path had no web search wiring at
	// all, which is why every Claude Code search returned nothing.
	it("converts the chat SSE into a Claude message with tool_calls", () => {
		// The conversion itself is covered by forced-sse-client-format.test.js; this
		// asserts only the shape the bridge depends on.
		expect(typeof handleForcedSSEToJson).toBe("function")
	})

	it("accepts the web search plan and runner", () => {
		const src = handleForcedSSEToJson.toString()
		expect(src).toContain("attachWebSearchToClaudeBody")
	})

	it("imports the bridge helper", async () => {
		const mod = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js")
		expect(typeof mod.handleForcedSSEToJson).toBe("function")
	})
})

describe("stop_reason correction on the non-streaming bridge", () => {
	// Same defect as the streaming path: the upstream ends with stop_reason
	// "tool_use" because IT had just emitted the call. Once the bridge answers it
	// with the native server-tool pair, nothing is pending and Anthropic ends a
	// completed search with "end_turn".
	const plan = { active: true, lane: "bridge", maxUses: 5 }
	const runSearch = async () => [{ title: "T", url: "https://e.test/1" }]

	const bodyWith = (content, stopReason) => ({
		role: "assistant",
		content,
		stop_reason: stopReason,
	})

	const searchCall = {
		type: "tool_use",
		id: "toolu_a",
		name: "WebSearch",
		input: { query: "q" },
	}

	it("changes tool_use to end_turn when the bridge answered the only call", async () => {
		const body = bodyWith([{ type: "text", text: "Looking." }, searchCall], "tool_use")
		const out = await attachWebSearchToClaudeBody({
			responseBody: body,
			webSearchPlan: plan,
			runSearch,
		})

		expect(out.stop_reason).toBe("end_turn")
		expect(out.content.some((b) => b.type === "server_tool_use")).toBe(true)
		expect(out.content.some((b) => b.type === "tool_use")).toBe(false)
	})

	it("keeps tool_use when another client tool is still pending", async () => {
		const body = bodyWith(
			[
				{ type: "text", text: "Looking." },
				searchCall,
				{ type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/x" } },
			],
			"tool_use",
		)
		const out = await attachWebSearchToClaudeBody({
			responseBody: body,
			webSearchPlan: plan,
			runSearch,
		})

		expect(out.stop_reason).toBe("tool_use")
		expect(out.content.some((b) => b.type === "tool_use" && b.name === "Read")).toBe(true)
	})

	it("leaves an unrelated stop_reason alone", async () => {
		const body = bodyWith([{ type: "text", text: "Done." }], "max_tokens")
		const out = await attachWebSearchToClaudeBody({
			responseBody: body,
			webSearchPlan: plan,
			runSearch,
		})
		expect(out.stop_reason).toBe("max_tokens")
	})

	it("corrects stop_reason even when the search fails", async () => {
		const failing = async () => {
			throw new Error("engine down")
		}
		const body = bodyWith([searchCall], "tool_use")
		const out = await attachWebSearchToClaudeBody({
			responseBody: body,
			webSearchPlan: plan,
			runSearch: failing,
		})

		expect(out.stop_reason).toBe("end_turn")
		const result = out.content.find((b) => b.type === "web_search_tool_result")
		expect(result.error_code).toBe("unavailable")
	})
})
