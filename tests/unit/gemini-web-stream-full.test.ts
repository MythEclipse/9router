import { describe, expect, it } from "vitest"
import { readGeminiStream } from "../../apps/web/open-sse/executors/gemini-web.js"

/** A wrb.fr frame whose `inner[4][0][1]` is the answer so far. */
function answerFrame(text: string): string {
	const inner = JSON.stringify({ 4: [{ 1: [text] }] })
	return `${JSON.stringify([["wrb.fr", null, inner]])}\n`
}

/** Google's own terminator: `[["e",<code>,...]]`. */
const TERMINAL_FRAME = `${JSON.stringify([["e", 4, null, null, 12345]])}\n`

function streamOf(...chunks: string[]): Response {
	const encoder = new TextEncoder()
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
				controller.close()
			},
		}),
	)
}

describe("gemini-web stream read", () => {
	it("keeps reading past the first parseable frame", async () => {
		// The pre-fix reader stopped here, because `answerFrame` parses. The
		// terminal frame is the only signal that the reply is complete.
		const raw = await readGeminiStream(streamOf(answerFrame("Hel"), TERMINAL_FRAME))

		expect(raw).toContain("Hel")
		expect(raw).toContain('[["e"')
	})

	it("stops at the terminal frame instead of draining the connection", async () => {
		const raw = await readGeminiStream(
			streamOf(answerFrame("Hello"), TERMINAL_FRAME, answerFrame("SHOULD-NOT-APPEAR")),
		)

		expect(raw).toContain('[["e"')
		expect(raw).not.toContain("SHOULD-NOT-APPEAR")
	})

	it("returns what arrived when the stream closes with no terminal frame", async () => {
		const raw = await readGeminiStream(streamOf(answerFrame("partial")))

		expect(raw).toContain("partial")
	})

	it("answers an empty body with an empty string", async () => {
		expect(await readGeminiStream(new Response(null))).toBe("")
	})
})
