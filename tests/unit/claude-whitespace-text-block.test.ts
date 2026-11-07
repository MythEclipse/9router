/**
 * Claude Code renders a text block whose content is only whitespace as "…".
 * Providers that separate turns with a bare "\n" made the translator open a
 * text block for that newline, so a transcript of tool calls showed one "…"
 * between every pair of tool summaries:
 *
 *   Searched for 3 patterns, read 7 files, listed 2 directories
 *   ...
 *   Searched for 1 pattern, listed 1 directory
 *   ...
 *
 * The block has to be held back, not the whitespace itself: "a" + " b" is one
 * sentence and must still arrive as "a b".
 */
import { describe, expect, it } from "vitest"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { createSSEStream } from "../../apps/web/open-sse/utils/stream.js"

const enc = new TextEncoder()
const dec = new TextDecoder()

async function run(lines: string[]) {
	const upstream = new ReadableStream({
		start(c) {
			for (const l of lines) c.enqueue(enc.encode(l))
			c.close()
		},
	})
	const transform = createSSEStream({
		mode: "translate",
		targetFormat: FORMATS.OPENAI,
		sourceFormat: FORMATS.CLAUDE,
		provider: "kiro",
		model: "qwen3-coder-next",
		body: { model: "qwen3-coder-next", messages: [] },
	})
	const reader = upstream.pipeThrough(transform).getReader()
	let out = ""
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		out += dec.decode(value, { stream: true })
	}
	return out
}

const chunk = (delta: object, finish: string | null = null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		model: "qwen3-coder-next",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`

const toolCall = (id: string, name: string, args: string) =>
	chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] })

const textBlocks = (sse: string) => (sse.match(/"type":"text"/g) || []).length
const textDeltas = (sse: string) =>
	[...sse.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) =>
		JSON.parse(`"${m[1]}"`),
	)

describe("a whitespace-only text block in a Claude stream", () => {
	it("is not opened for a lone newline before a tool call", async () => {
		const out = await run([
			chunk({ role: "assistant", content: "\n" }),
			toolCall("call_1", "Read", '{"file_path":"a"}'),
			chunk({}, "tool_calls"),
			"data: [DONE]\n\n",
		])

		expect(textBlocks(out)).toBe(0)
		expect(out).toContain('"type":"tool_use"')
	})

	it("is not opened for a run of whitespace spread over several deltas", async () => {
		const out = await run([
			chunk({ role: "assistant", content: "\n" }),
			chunk({ content: "\n" }),
			chunk({ content: "  " }),
			toolCall("call_1", "Grep", '{"pattern":"x"}'),
			chunk({}, "tool_calls"),
			"data: [DONE]\n\n",
		])

		expect(textBlocks(out)).toBe(0)
	})

	it("is still opened when the newline precedes real text", async () => {
		const out = await run([
			chunk({ role: "assistant", content: "\n" }),
			chunk({ content: "Reading the file." }),
			chunk({}, "stop"),
			"data: [DONE]\n\n",
		])

		expect(textBlocks(out)).toBe(1)
		expect(textDeltas(out)).toEqual(["\nReading the file."])
	})

	it("keeps whitespace that arrives after the block is open", async () => {
		const out = await run([
			chunk({ role: "assistant", content: "a" }),
			chunk({ content: " b" }),
			chunk({}, "stop"),
			"data: [DONE]\n\n",
		])

		expect(textDeltas(out)).toEqual(["a", " b"])
		expect(textDeltas(out).join("")).toBe("a b")
	})
})
