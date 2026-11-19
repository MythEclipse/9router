/**
 * Is the stream REAL, or does 9router collect the answer first?
 *
 * The previous tests prove a body is not drained before the Response is returned.
 * That is necessary but not sufficient: a pipeline can still add its own buffering
 * (a transform that waits for a full frame, a parser that batches, a proxy header
 * that lets a CDN collect). Those all look identical from the outside - the client
 * gets every token at the end - so the only honest check is to TIMESTAMP each
 * chunk as it reaches the consumer.
 *
 * This test drives the real `handleChatCore` pipeline against an upstream that
 * emits a token every `GAP_MS`. It then asserts, on the client's read timings:
 *
 *   - TTFT is small (the first token does not wait for the generation), and
 *   - consecutive chunks arrive spread out over time (they are not one burst).
 *
 * A buffering gateway fails both: TTFT ≈ total time, and every chunk arrives in
 * the same millisecond. A streaming gateway passes both with margin.
 */
import { describe, expect, it, vi } from "vitest"

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))

vi.mock("../../apps/web/open-sse/executors/index.js", () => ({
	getExecutor: vi.fn(() => ({
		execute: executeMock,
		refreshCredentials: vi.fn().mockResolvedValue(null),
	})),
}))

vi.mock("../../apps/web/open-sse/utils/requestLogger.js", () => ({
	createRequestLogger: vi.fn(async () => ({
		logClientRawRequest: vi.fn(),
		logRawRequest: vi.fn(),
		logTargetRequest: vi.fn(),
		logError: vi.fn(),
		appendProviderChunk: vi.fn(),
		appendConvertedChunk: vi.fn(),
	})),
}))

vi.mock("../../apps/web/open-sse/utils/clientDetector.js", () => ({
	detectClientTool: vi.fn(() => null),
	isNativePassthrough: vi.fn(() => false),
}))

vi.mock("../../apps/web/open-sse/utils/bypassHandler.js", () => ({
	handleBypassRequest: vi.fn(() => null),
}))

vi.mock("../../apps/web/open-sse/utils/streamHandler.js", async () => {
	const actual = await vi.importActual("../../apps/web/open-sse/utils/streamHandler.js")
	return {
		...actual,
		createStreamController: vi.fn(() => ({
			signal: new AbortController().signal,
			isConnected: () => true,
			handleComplete: vi.fn(),
			handleError: vi.fn(),
			handleDisconnect: vi.fn(),
			abort: vi.fn(),
		})),
	}
})

vi.mock("../../apps/web/open-sse/services/tokenRefresh.js", () => ({
	refreshWithRetry: vi.fn(),
}))

vi.mock("../../apps/web/open-sse/utils/proxyFetch.js", () => ({
	default: vi.fn(),
	proxyAwareFetch: vi.fn(),
}))

vi.mock("../../apps/web/open-sse/translator/formats/claude.js", () => ({
	normalizeClaudePassthrough: vi.fn(),
	anchorClaudeCache: vi.fn(),
	cacheConfigFrom: vi.fn(() => null),
}))

vi.mock("../../apps/web/open-sse/utils/toolDeduper.js", () => ({
	dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}))

vi.mock("../../apps/web/open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }))
vi.mock("../../apps/web/open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }))
vi.mock("../../apps/web/open-sse/rtk/index.js", () => ({
	compressMessages: vi.fn(() => null),
	formatRtkLog: vi.fn(() => ""),
}))
vi.mock("../../apps/web/open-sse/rtk/headroom.js", () => ({
	compressWithHeadroom: vi.fn(async () => null),
	formatHeadroomLog: vi.fn(() => ""),
	formatHeadroomSizeLog: vi.fn(() => ""),
	isHeadroomPhantomSavings: vi.fn(() => false),
}))

vi.mock("../../apps/web/open-sse/providers/capabilities.js", () => ({
	getCapabilitiesForModel: vi.fn(() => ({})),
}))

vi.mock("../../apps/web/open-sse/translator/concerns/modality.js", () => ({
	stripUnsupportedModalities: vi.fn(() => false),
}))

vi.mock("../../apps/web/open-sse/translator/concerns/prefetch.js", () => ({
	prefetchRemoteImages: vi.fn(async () => 0),
}))

vi.mock("../../apps/web/open-sse/handlers/chatCore/requestDetail.js", () => ({
	buildRequestDetail: vi.fn((detail) => detail),
	extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
	saveFailedUsage: vi.fn(),
}))

vi.mock("@/lib/usageDb.js", () => ({
	trackPendingRequest: vi.fn(),
	appendRequestLog: vi.fn(() => Promise.resolve()),
	saveRequestDetail: vi.fn(() => Promise.resolve()),
}))

const enc = new TextEncoder()

/** How long the fake model takes between tokens. */
const GAP_MS = 250
/** How many tokens the fake model produces. */
const TOKENS = 6

function frame(text: string) {
	return `data: ${JSON.stringify({
		id: "chatcmpl-live",
		object: "chat.completion.chunk",
		created: 1,
		model: "upstream-model",
		choices: [{ index: 0, delta: { content: text } }],
	})}\n\n`
}

/**
 * An upstream that behaves like a real model: one token every GAP_MS, then a
 * finish frame and [DONE]. Nothing is sent early, so any chunk the client
 * receives at time T was genuinely forwarded at time T.
 */
function pacedUpstream() {
	let index = 0
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index < TOKENS) {
				const token = `tok${index} `
				index++
				controller.enqueue(enc.encode(frame(token)))
				await new Promise((resolve) => setTimeout(resolve, GAP_MS))
				return
			}
			controller.enqueue(
				enc.encode(
					`data: ${JSON.stringify({
						id: "chatcmpl-live",
						object: "chat.completion.chunk",
						created: 1,
						model: "upstream-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\ndata: [DONE]\n\n`,
				),
			)
			controller.close()
		},
	})
}

function makeOptions() {
	const body = {
		model: "deepseek-chat",
		stream: true,
		messages: [{ role: "user", content: "count" }],
	}
	return {
		body,
		modelInfo: { provider: "deepseek", model: "deepseek-chat" },
		credentials: { apiKey: "sk-test" },
		clientRawRequest: {
			endpoint: "/v1/chat/completions",
			body,
			headers: { accept: "text/event-stream" },
		},
		connectionId: "test-connection",
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	}
}

/**
 * Read the whole body, recording when each chunk ARRIVES. This is the only
 * measurement that can tell a real stream from a collected one.
 */
async function readWithTimings(response: Response) {
	if (!response?.body) throw new Error("response has no body to read")
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

describe("the stream is real, not collected then flushed", { timeout: 30_000 }, () => {
	it("delivers the first token long before the generation ends", async () => {
		executeMock.mockResolvedValue({
			response: new Response(pacedUpstream(), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			url: "https://api.deepseek.com/chat/completions",
			headers: {},
			transformedBody: {},
		})

		const { handleChatCore } = await import("../../apps/web/open-sse/handlers/chatCore.js")
		const result = await handleChatCore(makeOptions())
		const { arrivals, totalMs } = await readWithTimings(result.response)

		const ttft = arrivals[0]?.at ?? totalMs
		const generationMs = GAP_MS * TOKENS

		// The upstream cannot finish before this much time has passed.
		expect(totalMs).toBeGreaterThanOrEqual(generationMs * 0.8)

		// TTFT must be a fraction of the total: the first token cannot have waited
		// for the answer. A buffering gateway gives ttft ≈ totalMs here.
		expect(ttft, `ttft=${ttft}ms total=${totalMs}ms`).toBeLessThan(totalMs * 0.5)
		expect(ttft, `ttft=${ttft}ms`).toBeLessThan(generationMs * 0.5)
	})

	it("spreads chunk arrivals over time instead of flushing one burst", async () => {
		executeMock.mockResolvedValue({
			response: new Response(pacedUpstream(), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			url: "https://api.deepseek.com/chat/completions",
			headers: {},
			transformedBody: {},
		})

		const { handleChatCore } = await import("../../apps/web/open-sse/handlers/chatCore.js")
		const result = await handleChatCore(makeOptions())
		const { arrivals } = await readWithTimings(result.response)

		// More than one arrival: a single burst would be one chunk.
		expect(arrivals.length, "chunks received").toBeGreaterThan(1)

		// The gap between first and last arrival must be a real fraction of the
		// generation. A buffered flush puts them all in the same few milliseconds.
		const spread = arrivals.at(-1)!.at - arrivals[0].at
		const generationMs = GAP_MS * TOKENS
		expect(spread, `spread=${spread}ms arrivals=${arrivals.length}`).toBeGreaterThan(
			generationMs * 0.5,
		)

		// And no single arrival may contain the whole answer.
		const allText = arrivals.map((a) => a.text).join("")
		for (const arrival of arrivals) {
			expect(arrival.text.length, "one chunk held the whole answer").toBeLessThan(allText.length)
		}
	})

	it("streams a JSON-content-type body too (no content-type is trusted blindly)", async () => {
		// Some upstreams omit or mislabel the content type. The bounded sniffer must
		// still detect SSE and forward it live rather than falling back to a buffer.
		executeMock.mockResolvedValue({
			response: new Response(pacedUpstream(), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			url: "https://api.deepseek.com/chat/completions",
			headers: {},
			transformedBody: {},
		})

		const { handleChatCore } = await import("../../apps/web/open-sse/handlers/chatCore.js")
		const result = await handleChatCore(makeOptions())
		const { arrivals, totalMs } = await readWithTimings(result.response)

		const ttft = arrivals[0]?.at ?? totalMs
		const generationMs = GAP_MS * TOKENS
		const spread = (arrivals.at(-1)?.at ?? 0) - (arrivals[0]?.at ?? 0)

		// Same two claims as the declared-SSE case. A mislabelled body that gets
		// buffered is still a buffered body, and this is the shape the sniffer exists
		// for - asserting only "more than one chunk" would pass on the old code,
		// because a drained body is also split into many chunks when replayed.
		expect(arrivals.length, "chunks received").toBeGreaterThan(1)
		expect(ttft, `ttft=${ttft}ms total=${totalMs}ms`).toBeLessThan(totalMs * 0.5)
		expect(spread, `spread=${spread}ms arrivals=${arrivals.length}`).toBeGreaterThan(
			generationMs * 0.5,
		)
	})
})
