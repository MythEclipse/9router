/**
 * Cursor's stream must be REAL too — same measurement as the OpenAI-shape lanes,
 * applied to the framed-protobuf path.
 *
 * Cursor is the provider most at risk of quietly collecting the answer: its reply
 * is `[flags:1][length:4][payload]` frames, so the obvious implementation waits
 * for the whole body and decodes it in one pass. `CursorFrameAssembler` exists to
 * remove that. This test proves the assembler actually delivers timing, not just
 * correct bytes: the upstream emits one frame every GAP_MS, and the client's
 * arrival timestamps must be spread across the generation.
 *
 * Correct content with all chunks in the same millisecond is the failure mode -
 * that is a buffered answer wearing a stream's clothes.
 */
import { describe, expect, it } from "vitest"

import { CursorExecutor } from "../../apps/web/open-sse/executors/cursor.js"
import { encodeField, wrapConnectRPCFrame } from "../../apps/web/open-sse/utils/cursorProtobuf.js"

const LEN = 2
const GAP_MS = 200
const FRAMES = 5

function cursorFrame(text: string) {
	const responseFields = [encodeField(1, LEN, text)]
	const response = Buffer.concat(responseFields.map((field) => Buffer.from(field)))
	const envelope = encodeField(2, LEN, response)
	return Buffer.from(wrapConnectRPCFrame(envelope))
}

/**
 * A Cursor upstream that emits one frame every GAP_MS, like a model producing
 * tokens. Frames are deliberately split across two writes so the assembler's
 * incremental path is what is being measured, not a lucky whole-chunk arrival.
 */
function pacedCursorUpstream() {
	let index = 0
	let pending: Buffer | null = null
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (pending) {
				controller.enqueue(new Uint8Array(pending))
				pending = null
				return
			}
			if (index >= FRAMES) {
				controller.close()
				return
			}
			const frame = cursorFrame(`tok${index} `)
			index++
			// Split the frame in half: the assembler must hold the first half.
			const half = Math.floor(frame.length / 2)
			controller.enqueue(new Uint8Array(frame.subarray(0, half)))
			pending = frame.subarray(half)
			await new Promise((resolve) => setTimeout(resolve, GAP_MS))
		},
	})
}

async function readWithTimings(response: Response) {
	if (!response?.body) throw new Error("response has no body")
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	const arrivals: Array<{ at: number; text: string }> = []
	const started = Date.now()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		arrivals.push({ at: Date.now() - started, text: decoder.decode(value, { stream: true }) })
	}
	return { arrivals, totalMs: Date.now() - started }
}

describe("Cursor streams frame-by-frame, not at the end", { timeout: 30_000 }, () => {
	/**
	 * Drive the real `execute()` path with a stubbed transport, so the test covers
	 * the wiring that decides whether to stream - not just the decoder. A timing
	 * test that calls `transformProtobufStreamToSSE` directly passes even when
	 * `execute()` buffers the body first, which is exactly the bug being guarded.
	 */
	async function runThroughExecute() {
		const executor = new CursorExecutor()
		const transport = { body: pacedCursorUpstream(), status: 200, headers: {} }
		// Stub only the network call; everything downstream is the real pipeline.
		const originalFetch = (executor as any).makeFetchRequest
		const originalHttp2 = (executor as any).makeHttp2Request
		;(executor as any).makeHttp2Request = async () => transport
		;(executor as any).makeFetchRequest = async () => transport
		try {
			const result = await executor.execute({
				model: "gpt-5.3-codex",
				body: {
					model: "gpt-5.3-codex",
					stream: true,
					// An image part keeps this on the classic protobuf transport: the
					// AgentService h2 path claims every all-text request, and this test is
					// about the protobuf decoder that used to buffer.
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "count" },
								{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
							],
						},
					],
				},
				stream: true,
				credentials: {
					accessToken: "token",
					providerSpecificData: { machineId: "machine-id-for-test", ghostMode: true },
				},
				signal: undefined,
				log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
				proxyOptions: null,
			})
			return result.response as Response
		} finally {
			;(executor as any).makeFetchRequest = originalFetch
			;(executor as any).makeHttp2Request = originalHttp2
		}
	}

	it("delivers the first frame long before the answer ends", async () => {
		const started = Date.now()
		const response = await runThroughExecute()
		const callMs = Date.now() - started

		// Returning a live stream must not wait for the body.
		expect(callMs, "execute returned without draining").toBeLessThan(1500)

		const { arrivals, totalMs } = await readWithTimings(response)
		const ttft = arrivals[0]?.at ?? totalMs
		const generationMs = GAP_MS * FRAMES

		expect(totalMs, `total=${totalMs}ms`).toBeGreaterThanOrEqual(generationMs * 0.8)
		expect(ttft, `ttft=${ttft}ms total=${totalMs}ms`).toBeLessThan(totalMs * 0.5)
	})

	it("spreads frame arrivals over time instead of one burst", async () => {
		const response = await runThroughExecute()
		const { arrivals } = await readWithTimings(response)

		expect(arrivals.length, "chunks received").toBeGreaterThan(1)
		const spread = (arrivals.at(-1)?.at ?? 0) - (arrivals[0]?.at ?? 0)
		const generationMs = GAP_MS * FRAMES
		expect(spread, `spread=${spread}ms arrivals=${arrivals.length}`).toBeGreaterThan(
			generationMs * 0.5,
		)
	})

	it("still forwards every token in order", async () => {
		const response = await runThroughExecute()
		const text = await response.text()
		const content = text
			.split("\n\n")
			.filter((chunk) => chunk.startsWith("data: "))
			.map((chunk) => chunk.slice("data: ".length))
			.filter((data) => data !== "[DONE]")
			.map((data) => JSON.parse(data))
			.map((event) => event.choices?.[0]?.delta?.content || "")
			.join("")

		// Incremental reassembly must not reorder, drop or duplicate tokens.
		expect(content).toBe("tok0 tok1 tok2 tok3 tok4 ")
	})
})
