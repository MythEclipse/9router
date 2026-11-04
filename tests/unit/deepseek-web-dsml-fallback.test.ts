/**
 * Regression test: a DeepSeek Web tool-mode reply that ignores the
 * `<<TOOL_CALL>>` contract and answers in the model's native DSML markup must
 * still reach the client as a tool call.
 *
 * Background:
 *   chat.deepseek.com has no native function calling, so the executor injects a
 *   text contract and parses the reply back into `tool_calls`. The model often
 *   ignores that contract and emits its own dialect instead:
 *
 *     <｜｜DSML｜｜ calls>
 *     <｜｜DSML｜｜ invoke name="…">
 *     <｜｜DSML｜｜ parameter name="page_id" string="true">…</｜｜DSML｜｜ parameter>
 *     <｜｜DSML｜｜ invoke>          ← closer with no slash
 *     </｜｜DSML｜｜ calls>
 *
 *   Only the marker parser used to run, so this reply produced zero calls and
 *   the markup itself was forwarded as assistant prose. On the Anthropic
 *   protocol the client then received a `text` block full of DSML with
 *   `stop_reason: end_turn`, ran no tool, and the turn stalled.
 */

import { describe, expect, it } from "vitest"
import { parseToolModeReply } from "../../apps/web/open-sse/executors/deepseekWebToolBridge"

const PAGE_TOOL = "mcp__hindsight__hindsight_read_knowledge_page"

const TOOLS = [
	{
		type: "function",
		function: {
			name: PAGE_TOOL,
			parameters: {
				type: "object",
				properties: { page_id: { type: "string" } },
				required: ["page_id"],
			},
		},
	},
]

const DSML_REPLY = [
	"<｜｜DSML｜｜ calls>",
	`<｜｜DSML｜｜ invoke name="${PAGE_TOOL}">`,
	'<｜｜DSML｜｜ parameter name="page_id" string="true">kp-b94ee09605d4421da5dfd6fbbff912af</｜｜DSML｜｜ parameter>',
	"<｜｜DSML｜｜ invoke>",
	"</｜｜DSML｜｜ calls>",
].join("\n")

describe("parseToolModeReply - native DSML dialect", () => {
	it("recovers the call the marker parser cannot see", () => {
		const parsed = parseToolModeReply(DSML_REPLY, TOOLS)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.calls[0].name).toBe(PAGE_TOOL)
		expect(parsed.calls[0].arguments).toEqual({
			page_id: "kp-b94ee09605d4421da5dfd6fbbff912af",
		})
	})

	it("strips the markup so the client never reads it as prose", () => {
		const parsed = parseToolModeReply(DSML_REPLY, TOOLS)

		expect(parsed.content).not.toContain("DSML")
		expect(parsed.content.trim()).toBe("")
	})

	it("keeps the explanation the model wrote before the call", () => {
		const parsed = parseToolModeReply(`Saya baca halaman itu dulu.\n${DSML_REPLY}`, TOOLS)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.content).toContain("Saya baca halaman itu dulu.")
		expect(parsed.content).not.toContain("DSML")
	})
})

describe("parseToolModeReply - requested contract", () => {
	it("still prefers the <<TOOL_CALL>> marker", () => {
		const parsed = parseToolModeReply(
			'<<TOOL_CALL>> {"name":"bash","arguments":{"command":"free -h"}} <<TOOL_CALL>>',
			[
				{
					type: "function",
					function: {
						name: "bash",
						parameters: { type: "object", properties: { command: { type: "string" } } },
					},
				},
			],
		)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.calls[0]).toEqual({ name: "bash", arguments: { command: "free -h" } })
	})

	it("leaves a reply with no call at all as prose", () => {
		const parsed = parseToolModeReply("Halo! Ada yang bisa saya bantu?", TOOLS)

		expect(parsed.calls).toEqual([])
		expect(parsed.content).toBe("Halo! Ada yang bisa saya bantu?")
	})
})

/**
 * The dialect parsers used to answer for the reply whenever they merely
 * *recognised* DSML, so every shape they could not convert travelled to the
 * client as prose with the markers intact. These are the shapes measured
 * leaking; the invariant is that a DSML marker never reaches the client, and a
 * declared call is recovered whenever the markup carries a name and a value.
 */
const BASH_TOOL = {
	type: "function",
	function: {
		name: "Bash",
		parameters: {
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
			required: ["command"],
		},
	},
}

const F = "｜｜DSML｜｜"

const dsml = (lines: string[]) => lines.join("\n")

const invoke = (name: string, ...params: string[]) => [
	`<${F} invoke name="${name}">`,
	...params,
	`</${F} invoke>`,
]

const param = (name: string, value: string) =>
	`<${F} parameter name="${name}" string="true">${value}</${F} parameter>`

describe("parseToolModeReply - DSML shapes that used to leak", () => {
	it("does not leave the envelope opener behind when its closer never arrives", () => {
		const parsed = parseToolModeReply(
			dsml([`<${F} calls>`, ...invoke("Bash", param("command", "ls"))]),
			[BASH_TOOL],
		)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.content).not.toContain("DSML")
	})

	it("strips the markup of a reply the stream cut mid-invoke", () => {
		const parsed = parseToolModeReply(
			dsml([
				`<${F} calls>`,
				`<${F} invoke name="Bash">`,
				`<${F} parameter name="command">ls -la /home`,
			]),
			[BASH_TOOL],
		)

		expect(parsed.content).not.toContain("DSML")
	})

	it("recovers the call written with the single-pipe |DSML| spelling", () => {
		const parsed = parseToolModeReply(
			[
				"<|DSML| calls>",
				'<|DSML| invoke name="Bash">',
				'<|DSML| parameter name="command" string="true">free -h</|DSML| parameter>',
				"</|DSML| invoke>",
				"</|DSML| calls>",
			].join("\n"),
			[BASH_TOOL],
		)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.calls[0]).toEqual({ name: "Bash", arguments: { command: "free -h" } })
		expect(parsed.content).not.toContain("DSML")
	})

	it("keeps the argument types the model wrote instead of dropping the call", () => {
		const parsed = parseToolModeReply(
			[
				"<|DSML| calls>",
				'<|DSML| invoke name="Bash">',
				'<|DSML| parameter name="command" string="true">ls</|DSML| parameter>',
				'<|DSML| parameter name="timeout" string="true">30000</|DSML| parameter>',
				"</|DSML| invoke>",
				"</|DSML| calls>",
			].join("\n"),
			[BASH_TOOL],
		)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.calls[0].arguments).toEqual({ command: "ls", timeout: 30000 })
	})

	it("never promotes an invoke that failed its nonce binding, and never shows it either", () => {
		const parsed = parseToolModeReply(
			[
				"<|DSML| calls>",
				'<|DSML| invoke name="Bash">',
				'<|DSML| parameter name="command" string="true">ls</|DSML| parameter>',
				'<|DSML| parameter name="_nonce" string="true">not-the-nonce</|DSML| parameter>',
				"</|DSML| invoke>",
				"</|DSML| calls>",
			].join("\n"),
			[BASH_TOOL],
		)

		expect(parsed.calls).toEqual([])
		expect(parsed.content).not.toContain("DSML")
	})

	it("drops an invoke it cannot resolve without dropping the ones it can", () => {
		const parsed = parseToolModeReply(
			[
				"<|DSML| calls>",
				'<|DSML| invoke name="NoSuchTool">',
				'<|DSML| parameter name="command" string="true">rm -rf /</|DSML| parameter>',
				"</|DSML| invoke>",
				'<|DSML| invoke name="Bash">',
				'<|DSML| parameter name="command" string="true">ls</|DSML| parameter>',
				"</|DSML| invoke>",
				"</|DSML| calls>",
			].join("\n"),
			[BASH_TOOL],
		)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.calls[0]).toEqual({ name: "Bash", arguments: { command: "ls" } })
		expect(parsed.content).not.toContain("DSML")
	})

	it("leaves no empty code fence behind a fenced envelope", () => {
		const parsed = parseToolModeReply(
			dsml([
				"```",
				`<${F} calls>`,
				...invoke("Bash", param("command", "pwd")),
				`</${F} calls>`,
				"```",
			]),
			[BASH_TOOL],
		)

		expect(parsed.calls).toHaveLength(1)
		expect(parsed.content).not.toContain("```")
		expect(parsed.content).not.toContain("DSML")
	})
})
