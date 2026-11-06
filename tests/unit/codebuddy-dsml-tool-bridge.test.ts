/**
 * Regression test: a CodeBuddy reply that declares a tool in the model's DSML dialect must
 * reach the client as `tool_calls`, not as assistant text.
 *
 * Background:
 *   CodeBuddy's gateway is OpenAI-compatible, but a DeepSeek model behind it has no
 *   function calling there and answers in the model's own dialect:
 *
 *     <｜｜DSML｜｜ calls>
 *     <｜｜DSML｜｜ invoke name="Bash">
 *     <｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>
 *     </｜｜DSML｜｜ invoke>
 *     </｜｜DSML｜｜ calls>
 *
 *   On the Anthropic protocol the client received that markup as a `text` block with
 *   `stop_reason: end_turn`, ran no tool, and the turn stalled.
 */

import { describe, expect, it } from "vitest"
import { CodeBuddyExecutor } from "../../apps/web/open-sse/executors/codebuddy-cn.js"
import { CodeBuddyIntlExecutor } from "../../apps/web/open-sse/executors/codebuddy-intl.js"
import { bridgeCodebuddyToolCalls } from "../../apps/web/open-sse/executors/codebuddyToolBridge.js"
import { DefaultExecutor } from "../../apps/web/open-sse/executors/default.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { createSSEStream } from "../../apps/web/open-sse/utils/stream.js"

const BASH_TOOL = {
	type: "function",
	function: {
		name: "Bash",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
}

const F = "｜｜DSML｜｜"

/** One upstream content delta, shaped like CodeBuddy's OpenAI-compatible SSE. */
const deltaFrame = (content: string) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1700000000,
		model: "deepseek-v4-pro",
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	})}`

const sseResponse = (frames: string[]) =>
	new Response(`${frames.join("\n\n")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	})

/** Split an SSE body back into its decoded `data:` payloads. */
const payloads = (body: string) =>
	body
		.split("\n\n")
		.map((frame) => frame.trim())
		.filter((frame) => frame.startsWith("data:"))
		.map((frame) => frame.slice(5).trim())
		.filter((data) => data !== "[DONE]")
		.map((data) => JSON.parse(data))

const textOf = (body: string) =>
	payloads(body)
		.map((payload) => payload?.choices?.[0]?.delta?.content ?? "")
		.join("")

const callsOf = (body: string) =>
	payloads(body).flatMap((payload) => payload?.choices?.[0]?.delta?.tool_calls ?? [])

const finishOf = (body: string) =>
	payloads(body)
		.map((payload) => payload?.choices?.[0]?.finish_reason)
		.filter(Boolean)
		.pop()

async function run(frames: string[], tools = [BASH_TOOL]) {
	const result = await bridgeCodebuddyToolCalls(
		{ response: sseResponse(frames), url: "u", headers: {}, transformedBody: {} },
		{ tools },
		"cbai",
	)
	return await result.response.text()
}

describe("bridgeCodebuddyToolCalls - DSML reply", () => {
	it("turns the declared call into tool_calls", async () => {
		const body = await run([
			deltaFrame(`<${F} calls>\n<${F} invoke name="Bash">\n`),
			deltaFrame(`<${F} parameter name="command" string="true">free -h</${F} parameter>\n`),
			deltaFrame(`</${F} invoke>\n</${F} calls>`),
		])

		expect(callsOf(body)).toHaveLength(1)
		expect(callsOf(body)[0].function.name).toBe("Bash")
		expect(JSON.parse(callsOf(body)[0].function.arguments)).toEqual({ command: "free -h" })
		expect(finishOf(body)).toBe("tool_calls")
		expect(textOf(body)).not.toContain("DSML")
	})

	it("keeps the prose the model wrote before the call, and only once", async () => {
		const body = await run([
			deltaFrame("Saya cek dulu.\n"),
			deltaFrame(`<${F} calls>\n<${F} invoke name="Bash">\n`),
			deltaFrame(`<${F} parameter name="command">ls</${F} parameter>\n</${F} invoke>\n</${F} calls>`),
		])

		expect(callsOf(body)).toHaveLength(1)
		expect(textOf(body)).toBe("Saya cek dulu.\n")
	})

	it("keeps the call a truncated reply declared, and strips the markup", async () => {
		const body = await run([deltaFrame(`<${F} calls>\n<${F} invoke name="Bash">`)])

		// The invoke never finished, so there are no arguments to recover — but the name is
		// declared, and a call the client can reject on its schema beats markup it must read
		// as prose while the turn stalls.
		expect(callsOf(body)).toHaveLength(1)
		expect(callsOf(body)[0].function.name).toBe("Bash")
		expect(textOf(body)).not.toContain("DSML")
		expect(finishOf(body)).toBe("tool_calls")
	})

	it("strips marker debris that declares no invoke at all", async () => {
		const body = await run([deltaFrame(`<${F} calls>\n`)])

		expect(callsOf(body)).toEqual([])
		expect(textOf(body)).not.toContain("DSML")
		expect(finishOf(body)).toBe("stop")
	})
})

describe("bridgeCodebuddyToolCalls - passthrough", () => {
	it("streams a reply with no DSML byte for byte", async () => {
		const frames = [deltaFrame("Halo, "), deltaFrame("ada yang bisa dibantu?")]
		const result = await bridgeCodebuddyToolCalls(
			{ response: sseResponse(frames), url: "u", headers: {}, transformedBody: {} },
			{ tools: [BASH_TOOL] },
			"cbai",
		)

		expect(await result.response.text()).toBe(`${frames.join("\n\n")}\n\ndata: [DONE]\n\n`)
	})

	it("returns the response untouched when the request carries no tools", async () => {
		const result = { response: sseResponse([deltaFrame(`<${F} calls>`)]), url: "u" }
		const bridged = await bridgeCodebuddyToolCalls(result, { tools: [] }, "cbai")

		expect(bridged).toBe(result)
	})

	it("returns the response untouched when upstream is not streaming", async () => {
		const result = {
			response: new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
			url: "u",
		}
		const bridged = await bridgeCodebuddyToolCalls(result, { tools: [BASH_TOOL] }, "cbai")

		expect(bridged).toBe(result)
	})
})

describe("CodeBuddy executors wire the bridge", () => {
	it.each([
		["codebuddy-cn", CodeBuddyExecutor],
		["codebuddy-intl", CodeBuddyIntlExecutor],
	])("%s turns a DSML reply into tool_calls", async (_name, Executor) => {
		const original = DefaultExecutor.prototype.execute
		DefaultExecutor.prototype.execute = async () => ({
			response: sseResponse([
				deltaFrame(`<${F} calls>\n<${F} invoke name="Bash">\n`),
				deltaFrame(`<${F} parameter name="command">ls</${F} parameter>\n</${F} invoke>\n</${F} calls>`),
			]),
			url: "u",
			headers: {},
			transformedBody: {},
		})
		try {
			const executor = new Executor()
			const result = await executor.execute({
				model: "deepseek-v4-pro",
				body: { tools: [BASH_TOOL], messages: [] },
				stream: true,
				credentials: {},
			})

			const body = await result.response.text()
			expect(callsOf(body)).toHaveLength(1)
			expect(callsOf(body)[0].function.name).toBe("Bash")
		} finally {
			DefaultExecutor.prototype.execute = original
		}
	})
})

describe("a Claude client of CodeBuddy", () => {
	it("receives tool_use, not the markup", async () => {
		const bridged = await bridgeCodebuddyToolCalls(
			{
				response: sseResponse([
					deltaFrame(`<${F} calls>\n<${F} invoke name="Bash">\n`),
					deltaFrame(`<${F} parameter name="command">free -h</${F} parameter>\n`),
					deltaFrame(`</${F} invoke>\n</${F} calls>`),
				]),
				url: "u",
				headers: {},
				transformedBody: {},
			},
			{ tools: [BASH_TOOL] },
			"cbai",
		)

		// The real openai→claude pipeline the /v1/messages route runs.
		const transform = createSSEStream({
			mode: "translate",
			targetFormat: FORMATS.OPENAI,
			sourceFormat: FORMATS.CLAUDE,
			provider: "codebuddy-intl",
			model: "deepseek-v4-pro",
			body: { model: "deepseek-v4-pro", messages: [], tools: [BASH_TOOL] },
		})
		const reader = bridged.response.body.pipeThrough(transform).getReader()
		let out = ""
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			out += new TextDecoder().decode(value, { stream: true })
		}

		expect(out).toContain('"type":"tool_use"')
		expect(out).toContain('"name":"Bash"')
		expect(out).toContain('"stop_reason":"tool_use"')
		expect(out).not.toContain("DSML")
	})
})

/**
 * The marker does not arrive in one frame. A real upstream stream sends a token at a time, so the
 * client is already being sent `<｜`, then `｜DSML｜`, before the whole marker is recognisable — and
 * those fragments used to reach it as assistant prose, ahead of the tool call. On the Anthropic
 * protocol that is a `text` block starting with `</｜｜DSML` next to the `tool_use` block.
 */
describe("bridgeCodebuddyToolCalls - a marker split across frames", () => {
	const INVOKE = `<${F} invoke name="Bash"><${F} parameter name="command" string="true">ls</${F} parameter></${F} invoke>`
	const oneTokenPerFrame = (text: string) => text.split("").map(deltaFrame)

	it("never forwards a marker fragment as prose", async () => {
		const body = await run(oneTokenPerFrame(INVOKE))

		expect(callsOf(body)).toHaveLength(1)
		expect(textOf(body)).toBe("")
	})

	it("keeps the prose that came before it, and only that", async () => {
		const body = await run(oneTokenPerFrame(`Sure:\n${INVOKE}`))

		expect(textOf(body)).toBe("Sure:\n")
		expect(callsOf(body)[0].function.arguments).toBe('{"command":"ls"}')
	})

	it("forwards prose ending in `<` unchanged when no marker follows", async () => {
		// The hold-back must not swallow legitimate text: `x <` is not the start of markup.
		const prose = "The value must satisfy x <"
		const body = await run(oneTokenPerFrame(prose))

		expect(textOf(body)).toBe(prose)
		expect(callsOf(body)).toEqual([])
		// No markup: the reply is untouched, so the upstream's own frames pass straight through.
		expect(body).not.toContain("tool_calls")
	})

	it("forwards a reply that only looks like markup unchanged", async () => {
		const prose = "<div>hello</div> and a literal <| on its own"
		const body = await run(oneTokenPerFrame(prose))

		expect(textOf(body)).toBe(prose)
		expect(callsOf(body)).toEqual([])
	})
})
