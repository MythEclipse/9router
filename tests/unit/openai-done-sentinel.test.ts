/**
 * A Chat Completions client's stream must close with exactly one
 * `data: [DONE]`. Two ways that broke, both verified live on production:
 *
 * - kr/qwen3-coder-next (Kiro) sent the sentinel upstream, the parser turned it
 *   into `parsed.done`, and nothing was re-emitted — the client saw the
 *   finish_reason chunk and then silence.
 * - gemini/gemini-3.5-flash-lite closed the body without ever sending it.
 *
 * A Claude client is the opposite case: it terminates on `message_stop` and must
 * not receive the OpenAI sentinel.
 */
import { describe, expect, it } from "vitest"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { createSSEStream } from "../../apps/web/open-sse/utils/stream.js"

const enc = new TextEncoder()
const dec = new TextDecoder()

async function runUpstream(lines: string[], sourceFormat: string) {
	const upstream = new ReadableStream({
		start(controller) {
			for (const line of lines) controller.enqueue(enc.encode(line))
			controller.close()
		},
	})

	const transform = createSSEStream({
		mode: "translate",
		targetFormat: FORMATS.OPENAI,
		sourceFormat,
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

const countDone = (sse: string) => (sse.match(/data: \[DONE\]/g) || []).length

describe("the [DONE] sentinel for a Chat Completions client", () => {
	it("is emitted once when the upstream sends it", async () => {
		const out = await runUpstream(
			[chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), "data: [DONE]\n\n"],
			FORMATS.OPENAI,
		)

		expect(countDone(out)).toBe(1)
		expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true)
	})

	it("is synthesized when the upstream body closes without it", async () => {
		const out = await runUpstream(
			[chunk({ role: "assistant", content: "hi" }), chunk({}, "stop")],
			FORMATS.OPENAI,
		)

		expect(countDone(out)).toBe(1)
	})

	it("keeps the content it was given", async () => {
		const out = await runUpstream(
			[chunk({ role: "assistant", content: "hello" }), chunk({}, "stop")],
			FORMATS.OPENAI,
		)

		expect(out).toContain("hello")
	})

	it("is not sent to a Claude client, which terminates on message_stop", async () => {
		const out = await runUpstream(
			[chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), "data: [DONE]\n\n"],
			FORMATS.CLAUDE,
		)

		expect(countDone(out)).toBe(0)
		expect(out).toContain("message_stop")
	})
})
