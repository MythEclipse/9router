import { describe, expect, it } from "vitest"
import { dedupeTools } from "../../apps/web/open-sse/utils/toolDeduper.js"

const BASH = (name = "Bash", desc = "Run a shell command") => ({
	name,
	description: desc,
	input_schema: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
	},
})

const FUNC_SHAPE = (name = "Bash") => ({
	type: "function",
	function: {
		name,
		description: "Run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } } },
	},
})

const MCP_EXA = { name: "mcp__exa__web_search_exa", description: "search" }

describe("toolDeduper — MCP-equivalent built-in rules (existing behavior)", () => {
	it("claude client + Exa MCP → drops built-in WebSearch/WebFetch", () => {
		const { tools, stripped } = dedupeTools(
			[
				MCP_EXA,
				{ name: "WebSearch", description: "web" },
				{ name: "WebFetch", description: "web" },
				BASH(),
			],
			{ clientTool: "claude" },
		)
		expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"])
		expect(stripped.sort()).toEqual(["WebFetch", "WebSearch"])
	})

	it("non-claude client → MCP built-in rules do NOT run (behavior preserved)", () => {
		const { tools, stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }], {
			clientTool: "codex",
		})
		expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "WebSearch"])
		expect(stripped).toEqual([])
	})

	it("legacy call without opts still applies MCP rules for claude callers (back-compat shape)", () => {
		// chatCore always passes opts now, but old direct callers keep prior behavior:
		// without clientTool, MCP rules stay dormant (they were claude-gated anyway).
		const { tools, stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }])
		expect(tools).toHaveLength(2)
		expect(stripped).toEqual([])
	})
})

describe("toolDeduper — DeepSeek same-name dedup (new)", () => {
	it("deepseek model + duplicate tool names → keeps first definition", () => {
		const first = BASH()
		const dup = BASH("Bash", "duplicate description")
		const { tools, stripped } = dedupeTools([first, dup], { model: "deepseek-v4-flash" })
		expect(tools).toEqual([first]) // first wins, including its description
		expect(stripped).toEqual(["Bash"])
	})

	it("deepseek model + (max) thinking suffix → still dedups (suffix stripped before match)", () => {
		const { tools, stripped } = dedupeTools([BASH(), BASH("Bash", "dup")], {
			model: "deepseek-v4-flash(max)",
		})
		expect(tools).toHaveLength(1)
		expect(stripped).toEqual(["Bash"])
	})

	it("deepseek + 3 same-name tools → keeps first, drops both duplicates", () => {
		const { tools, stripped } = dedupeTools([BASH(), BASH("Bash", "d1"), BASH("Bash", "d2")], {
			model: "deepseek-v4-pro",
		})
		expect(tools).toHaveLength(1)
		expect(stripped).toEqual(["Bash", "Bash"])
	})

	it("deepseek + OpenAI function-shape tools → dedups by function.name", () => {
		const { tools } = dedupeTools([FUNC_SHAPE("Bash"), FUNC_SHAPE("Bash")], {
			model: "deepseek-v4-flash",
		})
		expect(tools).toHaveLength(1)
		expect(tools[0].function.name).toBe("Bash")
	})

	it("non-DeepSeek model + duplicate tool names → untouched (GLM/MiniMax/Kimi accept them)", () => {
		const tools = [BASH(), BASH("Bash", "dup")]
		const { tools: out, stripped } = dedupeTools(tools, { model: "glm-5.2" })
		expect(out).toBe(tools)
		expect(stripped).toEqual([])
	})

	it("no model declared → same-name dedup does NOT run (safe default)", () => {
		const tools = [BASH(), BASH("Bash", "dup")]
		const { tools: out, stripped } = dedupeTools(tools, {})
		expect(out).toBe(tools)
		expect(stripped).toEqual([])
	})

	it("deepseek + distinct names → nothing stripped", () => {
		const { tools, stripped } = dedupeTools([BASH("Bash"), BASH("ReadFile")], {
			model: "deepseek-v4-flash",
		})
		expect(tools).toHaveLength(2)
		expect(stripped).toEqual([])
	})

	it("claude client + deepseek + MCP trigger → both rules apply (union stripped)", () => {
		const { tools, stripped } = dedupeTools(
			[MCP_EXA, { name: "WebSearch", description: "web" }, BASH(), BASH("Bash", "dup")],
			{ clientTool: "claude", model: "deepseek-v4-flash" },
		)
		expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"])
		expect(stripped.sort()).toEqual(["Bash", "WebSearch"])
	})
	describe("toolDeduper — tool_reference cleanup for stripped tools", () => {
		const toolResultMsg = (...blocks) => ({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: blocks }],
		})

		it("drops a tool_reference naming a stripped tool, keeps the others", () => {
			const messages = [
				toolResultMsg(
					{ type: "tool_reference", tool_name: "WebSearch" },
					{ type: "tool_reference", tool_name: "mcp__exa__web_search_exa" },
				),
			]
			const { stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }, BASH()], {
				clientTool: "claude",
				messages,
			})
			expect(stripped).toEqual(["WebSearch"])
			expect(messages[0].content[0].content).toEqual([
				{ type: "tool_reference", tool_name: "mcp__exa__web_search_exa" },
			])
		})

		it("leaves a text note when every reference is stripped (empty content is invalid)", () => {
			const messages = [toolResultMsg({ type: "tool_reference", tool_name: "WebFetch" })]
			dedupeTools([MCP_EXA, { name: "WebFetch", description: "web" }], {
				clientTool: "claude",
				messages,
			})
			expect(messages[0].content[0].content).toEqual([
				{ type: "text", text: "[Tool WebFetch is unavailable]" },
			])
		})

		it("only cleans blocks under tool_result; stray tool_reference blocks are untouched", () => {
			const stray = { type: "tool_reference", tool_name: "WebSearch" }
			const messages = [{ role: "user", content: [stray] }]
			dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }], {
				clientTool: "claude",
				messages,
			})
			expect(messages[0].content).toEqual([stray])
		})

		it("does nothing when no tool was stripped", () => {
			const messages = [toolResultMsg({ type: "tool_reference", tool_name: "WebSearch" })]
			const snapshot = structuredClone(messages)
			dedupeTools([BASH()], { clientTool: "claude", messages })
			expect(messages).toEqual(snapshot)
		})

		it("does nothing without a messages argument (back-compat)", () => {
			const { tools, stripped } = dedupeTools([MCP_EXA, { name: "WebSearch", description: "web" }], {
				clientTool: "claude",
			})
			expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa"])
			expect(stripped).toEqual(["WebSearch"])
		})
	})
})
