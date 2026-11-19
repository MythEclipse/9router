/**
 * Cursor must stream. Its reply is length-prefixed protobuf, which is why the
 * transport used to `arrayBuffer()` the whole answer before decoding anything:
 * `readCursorFrame()` needs a complete frame, so the old code waited for the
 * model to finish and then sent every frame in one burst.
 *
 * `CursorFrameAssembler` removes that constraint by holding a partial frame
 * until its declared length has arrived. These tests pin the two things that
 * makes possible, and the one thing it must not break:
 *
 *  1. Frames are emitted as their bytes arrive — the first frame reaches the
 *     client while the upstream body is still open.
 *  2. A frame split across chunk boundaries is reassembled byte-exactly, in
 *     order, with no duplication and no loss.
 *  3. The buffered decoder still produces identical output for the same bytes,
 *     so the non-streaming (JSON) path and the h2 transport are unaffected.
 *
 * The latency assertions use a body that PARKS after its first frame: anything
 * that reads to completion hangs, so a pass means the bytes really were
 * forwarded live. Content-only assertions cannot see the old bug.
 */
import { describe, expect, it, vi } from "vitest"

import { CursorExecutor } from "../../apps/web/open-sse/executors/cursor.js"
import { CursorFrameAssembler } from "../../apps/web/open-sse/executors/cursorFrame.js"
import { makeFetchRequest } from "../../apps/web/open-sse/executors/cursorTransport.js"
import { encodeField, wrapConnectRPCFrame } from "../../apps/web/open-sse/utils/cursorProtobuf.js"
import * as proxyFetch from "../../apps/web/open-sse/utils/proxyFetch.js"

const LEN = 2

function cursorResponseFrame({ text = "", thinking = "" }) {
	const responseFields = []
	if (text) responseFields.push(encodeField(1, LEN, text))
	if (thinking) {
		const thinkingMessage = encodeField(1, LEN, thinking)
		responseFields.push(encodeField(25, LEN, thinkingMessage))
	}
	const response = Buffer.concat(responseFields.map((field) => Buffer.from(field)))
	const envelope = encodeField(2, LEN, response)
	return Buffer.from(wrapConnectRPCFrame(envelope))
}

function parseSSE(text: string) {
	return text
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data: "))
		.map((chunk) => chunk.slice("data: ".length))
		.filter((data) => data !== "[DONE]")
		.map((data) => JSON.parse(data))
}

function joinedContent(events: any[]) {
	return events.map((event) => event.choices?.[0]?.delta?.content || "").join("")
}

/** Turn a Buffer into a ReadableStream that emits it in the given slice sizes. */
function chunkedStream(buffer: Buffer, sizes: number[]) {
	let offset = 0
	let index = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= buffer.length) {
				controller.close()
				return
			}
			const size = sizes[index++ % sizes.length] ?? buffer.length
			const end = Math.min(offset + size, buffer.length)
			controller.enqueue(new Uint8Array(buffer.subarray(offset, end)))
			offset = end
		},
	})
}

/**
 * A body that emits one complete frame, then PARKS until released. A consumer
 * that reads to completion hangs, so elapsed time proves whether the first frame
 * was forwarded live.
 */
function parkedFrameStream(frame: Buffer) {
	let release: (() => void) | null = null
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
			c.enqueue(new Uint8Array(frame))
		},
		async pull() {
			await new Promise<void>((resolve) => {
				release = resolve
			})
			controller?.close()
		},
	})
	return { body, release: () => release?.() }
}

async function firstChunkWithin(response: Response, ms: number) {
	if (!response?.body) return null
	const reader = response.body.getReader()
	const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))
	const read = reader.read().then((r) => (r.done ? null : r.value))
	const winner = await Promise.race([read, timeout])
	if (winner === "timeout") {
		try {
			await reader.cancel()
		} catch {
			/* already gone */
		}
		return "timeout"
	}
	return winner
}

describe("CursorFrameAssembler reassembles frames across chunk boundaries", () => {
	it("emits a frame only once its declared length has arrived", () => {
		const frame = cursorResponseFrame({ text: "hello" })
		const assembler = new CursorFrameAssembler()

		// Header only: 1 byte flags + 4 bytes length, no payload yet.
		expect(assembler.push(frame.subarray(0, 5))).toHaveLength(0)
		expect(assembler.pendingBytes).toBe(5)

		// The rest completes exactly one frame.
		const frames = assembler.push(frame.subarray(5))
		expect(frames).toHaveLength(1)
		expect(frames[0].status).toBe("ok")
		expect(assembler.pendingBytes).toBe(0)
	})

	it("reassembles byte-for-byte when split at every offset", () => {
		const frame = cursorResponseFrame({ text: "split me" })
		for (let split = 1; split < frame.length; split++) {
			const assembler = new CursorFrameAssembler()
			const first = assembler.push(frame.subarray(0, split))
			const second = assembler.push(frame.subarray(split))
			const all = [...first, ...second]
			expect(all, `split at ${split}`).toHaveLength(1)
			expect(all[0].payload?.toString("hex"), `split at ${split}`).toBe(
				frame.subarray(5).toString("hex"),
			)
		}
	})

	it("emits several frames from one chunk in order", () => {
		const a = cursorResponseFrame({ text: "one" })
		const b = cursorResponseFrame({ text: "two" })
		const assembler = new CursorFrameAssembler()
		const frames = assembler.push(Buffer.concat([a, b]))
		expect(frames).toHaveLength(2)
		expect(frames.every((f) => f.status === "ok")).toBe(true)
	})
})

describe("Cursor streams its framed reply", () => {
	it("forwards the first frame before the upstream body ends", async () => {
		const executor = new CursorExecutor()
		const frame = cursorResponseFrame({ text: "first" })
		const parked = parkedFrameStream(frame)

		const started = Date.now()
		const response = executor.transformProtobufStreamToSSE(parked.body, "gpt-5.3-codex", {
			messages: [{ role: "user", content: "hi" }],
		})
		const ttfbMs = Date.now() - started

		// The call itself must return while the upstream is still open.
		expect(ttfbMs, "returned before the body ended").toBeLessThan(2000)

		const chunk = await firstChunkWithin(response, 2000)
		expect(chunk, "produced a first chunk").not.toBeNull()
		expect(chunk, "did not time out waiting for a first chunk").not.toBe("timeout")
		expect(new TextDecoder().decode(chunk as Uint8Array)).toContain("data:")

		parked.release()
	})

	it("produces the same SSE content as the buffered decoder", async () => {
		const executor = new CursorExecutor()
		const buffer = Buffer.concat([
			cursorResponseFrame({ text: "Hello" }),
			cursorResponseFrame({ text: " world" }),
		])
		const body = { messages: [{ role: "user", content: "hi" }] }

		// Buffered path.
		const buffered = await executor.transformProtobufToSSE(buffer, "gpt-5.3-codex", body).text()

		// Streaming path, fed in awkward 3-byte slices so frames straddle chunks.
		const streamed = await executor
			.transformProtobufStreamToSSE(chunkedStream(buffer, [3]), "gpt-5.3-codex", body)
			.text()

		expect(joinedContent(parseSSE(streamed))).toBe("Hello world")
		expect(joinedContent(parseSSE(streamed))).toBe(joinedContent(parseSSE(buffered)))

		// Both must terminate the stream for the client.
		expect(streamed.trimEnd().endsWith("data: [DONE]")).toBe(true)
	})

	it("keeps Composer thinking scrubbed on the streaming path", async () => {
		const executor = new CursorExecutor()
		const buffer = Buffer.concat([
			cursorResponseFrame({ thinking: "private reasoning" }),
			cursorResponseFrame({ thinking: " that must not leak</think>O" }),
			cursorResponseFrame({ thinking: "K" }),
		])

		const streamed = await executor
			.transformProtobufStreamToSSE(chunkedStream(buffer, [7]), "composer-2.5-fast", {
				messages: [{ role: "user", content: "reply OK" }],
			})
			.text()
		const events = parseSSE(streamed)

		expect(joinedContent(events)).toBe("OK")
		expect(JSON.stringify(events)).not.toContain("private reasoning")
	})

	it("dispatches to the streaming path when the body is a stream", async () => {
		const executor = new CursorExecutor()
		const frame = cursorResponseFrame({ text: "live" })
		const parked = parkedFrameStream(frame)

		const started = Date.now()
		const response = await executor.transformProtobufToSSEOrStream(
			{ body: parked.body },
			"gpt-5.3-codex",
			{ messages: [{ role: "user", content: "hi" }] },
		)
		expect(Date.now() - started, "dispatcher did not wait for the body").toBeLessThan(2000)

		const chunk = await firstChunkWithin(response, 2000)
		expect(chunk).not.toBe("timeout")
		expect(chunk).not.toBeNull()
		parked.release()
	})

	it("still decodes a Buffer body through the buffered path", async () => {
		const executor = new CursorExecutor()
		const buffer = cursorResponseFrame({ text: "buffered" })
		const response = await executor.transformProtobufToSSEOrStream(
			{ body: buffer },
			"gpt-5.3-codex",
			{ messages: [{ role: "user", content: "hi" }] },
		)
		expect(joinedContent(parseSSE(await response.text()))).toBe("buffered")
	})
})

/**
 * The transport is what decides whether Cursor streams at all: if `makeFetchRequest`
 * drains the body with `arrayBuffer()`, the streaming decoder never sees a live
 * stream and every answer is buffered — while the decoder tests above still pass,
 * because they call the decoder directly. This pins the transport contract.
 */
describe("Cursor transport hands back a live body", () => {
	it("does not drain the upstream response", async () => {
		const parked = parkedFrameStream(cursorResponseFrame({ text: "first" }))
		const fetchSpy = vi
			.spyOn(proxyFetch, "proxyAwareFetch")
			.mockResolvedValue(new Response(parked.body, { status: 200 }))

		try {
			const started = Date.now()
			const result = await makeFetchRequest(
				"https://api2.cursor.sh/chat/completions",
				{ "content-type": "application/connect+proto" },
				Buffer.from("payload"),
			)
			// Draining would block here until the parked body ends.
			expect(Date.now() - started, "transport returned without draining").toBeLessThan(2000)

			expect(typeof (result.body as ReadableStream<Uint8Array>)?.getReader).toBe("function")
		} finally {
			fetchSpy.mockRestore()
			parked.release()
		}
	})
})
