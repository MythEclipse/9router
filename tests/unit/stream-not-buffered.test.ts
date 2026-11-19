/**
 * A gateway must stream. The upstream body is never drained before the client
 * sees its first byte.
 *
 * The bug this locks down: both response-shape checks used
 * `await response.clone().text()` to decide whether the upstream spoke SSE or
 * answered with one JSON document. `clone().text()` reads the clone to
 * COMPLETION, so the decision itself waited for the whole generation. Every
 * streamed answer therefore reached the client in a single burst after the model
 * had finished - correct bytes, wrong latency, and indistinguishable from a
 * working stream in any test that only asserts on content.
 *
 * What is asserted here:
 *
 *  1. `sniffResponseBody` returns before the stream ends - it reads a bounded
 *     prefix, not the whole body.
 *  2. The response it hands back still carries every byte, in order, including
 *     the bytes it read while deciding.
 *  3. A declared `text/event-stream` body is never read at all.
 *  4. `responseBodyNeedsParseRetry` does not wait for a stream to finish.
 */
import { describe, expect, it, vi } from "vitest"
import { responseBodyNeedsParseRetry } from "../../apps/web/open-sse/handlers/chatCore/executorDispatch.js"
import {
	isEventStreamResponse,
	sniffResponseBody,
} from "../../apps/web/open-sse/transformer/jsonToStreamConverter.js"

vi.mock("@/lib/usageDb.js", () => ({
	saveRequestDetail: vi.fn(async () => {}),
	saveRequestUsage: vi.fn(async () => {}),
	appendRequestLog: vi.fn(async () => {}),
	trackPendingRequest: vi.fn(),
}))

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * A body that emits `frames` one at a time and then never ends until `release()`
 * is called. Any consumer that reads to completion hangs here, which is exactly
 * what `clone().text()` used to do.
 */
function openEndedStream(frames: string[]) {
	let i = 0
	let release: (() => void) | null = null
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i < frames.length) {
				controller.enqueue(enc.encode(frames[i++]))
				return
			}
			// Park: no more frames, stream deliberately left open.
			await new Promise<void>((resolve) => {
				release = resolve
			})
			controller.close()
		},
	})
	return {
		body,
		release: () => release?.(),
	}
}

function responseOf(body: ReadableStream<Uint8Array>, contentType = "text/plain") {
	return new Response(body, { status: 200, headers: { "content-type": contentType } })
}

describe("sniffResponseBody keeps a stream streaming", () => {
	it("decides on a bounded prefix without waiting for the body to end", async () => {
		// An SSE body with no content-type: the case that used to need a full read.
		const { body, release } = openEndedStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'])
		const sniffed = await sniffResponseBody(responseOf(body), { deadlineMs: 2000 })
		expect(sniffed.kind).toBe("sse")
		expect(sniffed.prefix).toContain("data:")
		release()
	})

	it("replays every byte it read, in order", async () => {
		const frames = ["data: one\n\n", "data: two\n\n", "data: three\n\n"]
		const sniffed = await sniffResponseBody(
			responseOf(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const frame of frames) controller.enqueue(enc.encode(frame))
						controller.close()
					},
				}),
			),
			{ deadlineMs: 2000 },
		)

		// The decision is made on the FIRST decisive chunk, not on the whole body:
		// that is the property that keeps the client's first token early.
		expect(sniffed.prefix).toBe(frames[0])
		// Everything the sniffer consumed is replayed ahead of the live body, so
		// the downstream consumer still sees the complete, ordered stream.
		expect(await sniffed.response.text()).toBe(frames.join(""))
	})

	it("does not read a body that already declares text/event-stream", async () => {
		let reads = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads++
				controller.enqueue(enc.encode("data: x\n\n"))
				controller.close()
			},
		})
		const response = responseOf(body, "text/event-stream")
		const sniffed = await sniffResponseBody(response, { deadlineMs: 2000 })

		expect(sniffed.kind).toBe("sse")
		// The very same response object, untouched, and its body never locked by a
		// reader - which is what proves the sniffer did not touch it.
		expect(sniffed.response).toBe(response)
		expect(response.body?.locked).toBe(false)
		expect(await response.text()).toBe("data: x\n\n")
	})

	it("reports a JSON answer and still replays it", async () => {
		const document = JSON.stringify({ choices: [{ message: { content: "hi" } }] })
		const sniffed = await sniffResponseBody(
			responseOf(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(enc.encode(document))
						controller.close()
					},
				}),
			),
			{ deadlineMs: 2000 },
		)
		expect(sniffed.kind).toBe("json")
		expect(await sniffed.response.text()).toBe(document)
	})

	it("fails open on a silent body instead of holding the request", async () => {
		// Nothing arrives at all: the deadline must fire and hand back an unknown
		// body rather than wait for a first chunk that may never come.
		const { body, release } = openEndedStream([])
		const started = Date.now()
		const sniffed = await sniffResponseBody(responseOf(body), { deadlineMs: 50 })
		const elapsed = Date.now() - started

		expect(sniffed.kind).toBe("unknown")
		expect(elapsed).toBeLessThan(2000)
		release()
	})
})

describe("responseBodyNeedsParseRetry does not drain a stream", () => {
	it("returns without waiting for a declared SSE body to finish", async () => {
		const { body, release } = openEndedStream(['data: {"choices":[]}\n\n'])
		const response = responseOf(body, "text/event-stream")
		expect(isEventStreamResponse(response)).toBe(true)

		const started = Date.now()
		expect(await responseBodyNeedsParseRetry(response)).toBe(false)
		expect(Date.now() - started).toBeLessThan(2000)
		release()
	})

	it("returns without waiting for an undeclared SSE body to finish", async () => {
		const { body, release } = openEndedStream(['data: {"choices":[]}\n\n'])
		const response = responseOf(body, "text/plain")

		const started = Date.now()
		expect(await responseBodyNeedsParseRetry(response)).toBe(false)
		expect(Date.now() - started).toBeLessThan(2000)
		release()
	})

	it("still flags an empty body for a retry", async () => {
		const response = new Response("", { status: 200, headers: { "content-type": "text/plain" } })
		expect(await responseBodyNeedsParseRetry(response)).toBe(true)
	})
})
