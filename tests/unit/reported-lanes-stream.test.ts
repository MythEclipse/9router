/**
 * The three lanes the report named — CodeBuddy, DeepSeek, NVIDIA NIM — must reach
 * the client as a stream, not as one burst after the model finishes.
 *
 * Each provider takes a different route through the engine, and each route had
 * its own way of collecting the answer first:
 *
 *   codebuddy-cn / codebuddy-intl  `forceStream: true` — upstream refuses a
 *       non-streaming request, so the engine always asks for SSE. A JSON client
 *       therefore *depends* on the forced-SSE-to-JSON path, and a streaming
 *       client depends on the SSE body being forwarded untouched.
 *   deepseek  plain OpenAI-compatible, no forceStream — the shape decision is
 *       made on whatever the upstream sent, which is the gate that used to drain
 *       the body (`clone().text()`).
 *   nvidia    plain OpenAI-compatible with `dropClientMetadata` — same gate.
 *
 * The assertion is a LATENCY BOUND, not content: the upstream body parks after
 * its first frame and never ends. Anything that reads to completion hangs, so a
 * pass here means the client got its first byte while the model was still
 * generating. Content assertions cannot see this bug.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

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
	// Keep the real pipeWithDisconnect (the streaming path under test), and only
	// stub the controller's bookkeeping.
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
const dec = new TextDecoder()

/**
 * An upstream SSE body that emits its first frame and then PARKS — it never
 * closes until `release()` is called. A consumer that reads to completion hangs,
 * so the elapsed time tells us whether the first byte was forwarded live.
 * `release()` both unparks and CLOSES the body, so a caller that legitimately
 * waits for the end (the forced-SSE-to-JSON path) can finish.
 */
function parkedSseStream() {
	let release: (() => void) | null = null
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
			c.enqueue(
				enc.encode(
					`data: ${JSON.stringify({
						id: "chatcmpl-up",
						object: "chat.completion.chunk",
						created: 1,
						model: "upstream-model",
						choices: [{ index: 0, delta: { role: "assistant", content: "first" } }],
					})}\n\n`,
				),
			)
		},
		async pull() {
			await new Promise<void>((resolve) => {
				release = resolve
			})
			// End the answer once the test is done with it, so a consumer waiting
			// for the terminal frame is not left hanging.
			controller?.enqueue(
				enc.encode(
					`data: ${JSON.stringify({
						id: "chatcmpl-up",
						object: "chat.completion.chunk",
						created: 1,
						model: "upstream-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\ndata: [DONE]\n\n`,
				),
			)
			controller?.close()
		},
	})
	return { body, release: () => release?.() }
}

function upstreamResponse(body: ReadableStream<Uint8Array>) {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	})
}

function makeOptions(provider: string, model: string) {
	const body = {
		model: `${model}`,
		stream: true,
		messages: [{ role: "user", content: "hello" }],
	}
	return {
		body,
		modelInfo: { provider, model },
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

/** Read the first chunk from a response body, with a hard cap so a hang fails fast. */
async function firstChunkWithin(response: Response | null | undefined, ms: number) {
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

const LANES = [
	{ provider: "codebuddy-cn", model: "glm-5.3", forced: true },
	{ provider: "codebuddy-intl", model: "glm-5.3", forced: true },
	{ provider: "deepseek", model: "deepseek-chat", forced: false },
	{ provider: "nvidia", model: "meta/llama-3.3-70b-instruct", forced: false },
]

/**
 * DeepSeek declares a SECOND transport for Anthropic-format clients
 * (`/anthropic/v1/messages`). It is a different upstream, a different body shape
 * and a different SSE dialect, so it needs its own streaming proof — a fix at the
 * openai transport does not carry over by assumption.
 */
function makeClaudeOptions(provider: string, model: string) {
	const body = {
		model,
		stream: true,
		max_tokens: 1024,
		messages: [{ role: "user", content: "hello" }],
	}
	return {
		body,
		modelInfo: { provider, model },
		credentials: { apiKey: "sk-test" },
		clientRawRequest: {
			endpoint: "/v1/messages",
			body,
			headers: { accept: "text/event-stream", "anthropic-version": "2023-06-01" },
		},
		connectionId: "test-connection",
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	}
}

/** Anthropic-shaped SSE frames (event: + data: pairs), parked after the first. */
function parkedAnthropicSseStream() {
	let release: (() => void) | null = null
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
			c.enqueue(
				enc.encode(
					`event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: {
							id: "msg_up",
							type: "message",
							role: "assistant",
							model: "upstream-model",
							content: [],
							usage: { input_tokens: 3, output_tokens: 0 },
						},
					})}\n\n`,
				),
			)
		},
		async pull() {
			await new Promise<void>((resolve) => {
				release = resolve
			})
			controller?.enqueue(
				enc.encode(
					`event: content_block_delta\ndata: ${JSON.stringify({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "first" },
					})}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
				),
			)
			controller?.close()
		},
	})
	return { body, release: () => release?.() }
}

describe("the reported provider lanes stream instead of collecting", { timeout: 30_000 }, () => {
	beforeEach(() => {
		executeMock.mockReset()
	})

	it.each(LANES)(
		"$provider forwards the first upstream frame before the answer ends",
		async ({ provider, model }) => {
			const parked = parkedSseStream()
			executeMock.mockResolvedValue({
				response: upstreamResponse(parked.body),
				url: "https://upstream.test/chat/completions",
				headers: {},
				transformedBody: {},
			})

			const { handleChatCore } = await import("../../apps/web/open-sse/handlers/chatCore.js")
			const started = Date.now()
			const result = await handleChatCore(makeOptions(provider, model))
			const ttfbMs = Date.now() - started

			// The call itself must return while the upstream is still open: this is
			// the whole point. A drained body cannot satisfy it.
			expect(ttfbMs, `${provider} returned before the body ended`).toBeLessThan(3000)

			const chunk = await firstChunkWithin(result.response, 3000)
			expect(chunk, `${provider} produced a first chunk`).not.toBeNull()
			expect(chunk, `${provider} did not time out waiting for a first chunk`).not.toBe("timeout")
			expect(dec.decode(chunk as Uint8Array)).toContain("data:")

			parked.release()
		},
	)

	it.each(LANES.filter((lane) => lane.forced))(
		"$provider forces stream upstream even when the client asked for JSON",
		async ({ provider, model }) => {
			const parked = parkedSseStream()
			executeMock.mockResolvedValue({
				response: upstreamResponse(parked.body),
				url: "https://upstream.test/chat/completions",
				headers: {},
				transformedBody: {},
			})

			const { handleChatCore } = await import("../../apps/web/open-sse/handlers/chatCore.js")
			const options = makeOptions(provider, model)
			options.body.stream = false
			options.clientRawRequest.headers.accept = "application/json"

			// Fire and settle quickly: a JSON client is served by aggregating the
			// forced SSE, so this call legitimately waits for the body. What must
			// hold is that the EXECUTOR was asked to stream.
			const pending = handleChatCore(options)
			await vi.waitFor(() => expect(executeMock).toHaveBeenCalled(), { timeout: 5000 })
			expect(executeMock.mock.calls[0][0].stream, `${provider} asks upstream to stream`).toBe(true)
			parked.release()
			await pending.catch(() => {})
		},
	)

	/**
	 * DeepSeek's Anthropic-format transport. It resolves through
	 * `resolveTransport(provider, "claude")` to a different URL and body shape, so
	 * it is a separate lane: the openai-transport proof above says nothing about it.
	 */
	it("deepseek's claude transport forwards the first frame before the answer ends", async () => {
		const parked = parkedAnthropicSseStream()
		executeMock.mockResolvedValue({
			response: new Response(parked.body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			url: "https://api.deepseek.com/anthropic/v1/messages",
			headers: {},
			transformedBody: {},
		})

		const { handleChatCore } = await import("../../apps/web/open-sse/handlers/chatCore.js")
		const started = Date.now()
		const result = await handleChatCore(makeClaudeOptions("deepseek", "deepseek-chat"))
		const ttfbMs = Date.now() - started

		// Same latency claim as the openai lanes: the call returns while the
		// upstream body is still open.
		expect(ttfbMs, "deepseek claude transport returned before the body ended").toBeLessThan(3000)

		const chunk = await firstChunkWithin(result.response, 3000)
		expect(chunk, "deepseek claude transport produced a first chunk").not.toBeNull()
		expect(chunk, "deepseek claude transport did not time out").not.toBe("timeout")
		// A chunk boundary can land on either line of an Anthropic SSE frame
		// (`event: …` then `data: …`), so accept either - the claim is that a live
		// frame arrived, not which of its two lines came first.
		expect(dec.decode(chunk as Uint8Array)).toMatch(/^(event|data):/)

		parked.release()
	})

	it("deepseek's claude transport is the one resolved for an Anthropic client", async () => {
		// Guard the assumption the test above rests on: if the transport resolution
		// ever stops picking /anthropic/v1/messages, that test would silently start
		// exercising the openai lane and keep passing.
		const { resolveTransport } = await import("../../apps/web/open-sse/services/provider.js")
		const transport = resolveTransport("deepseek", "claude")
		expect(transport, "deepseek declares a claude transport").toBeTruthy()
		expect(transport.format).toBe("claude")
		expect(transport.baseUrl).toContain("/anthropic/v1/messages")
	})
})
