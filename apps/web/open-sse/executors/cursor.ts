import crypto from "node:crypto"
import zlib from "node:zlib"
import { PROVIDER_OAUTH, PROVIDERS } from "../config/providers.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { resolveAutoModelSelection, resolveCursorModels } from "../services/cursorModels.ts"
import { FORMATS } from "../translator/formats.ts"
import { OPENAI_BLOCK, ROLE } from "../translator/schema/index.ts"
import type { ChatRequestBody, ProxyOptions } from "../types.ts"
import { buildCursorHeaders } from "../utils/cursorChecksum.ts"
import {
	decodeMcpArgs,
	decodeMessage,
	encodeField,
	encodeMcpTools,
	extractTextFromResponse,
	generateCursorBody,
	wrapConnectRPCFrame,
} from "../utils/cursorProtobuf.ts"
import { proxyAwareFetch } from "../utils/proxyFetch.ts"
import { chatChunkSse, sseChunk } from "../utils/sse.ts"
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.ts"
import { estimateUsage } from "../utils/usageTracking.ts"
import { BaseExecutor } from "./base.ts"
import {
	AGENT_RUN_PATH,
	agentMessage,
	buildAgentRunFrame,
	createRequestContextResponse,
	decodeAgentFrames,
	encodeKvClientMessage,
	extractAgentString,
	isAgentCapableRequest,
	rejectExecRequest,
} from "./cursorProto.ts"

export { buildAgentRunFrame, encodeKvClientMessage, isAgentCapableRequest } from "./cursorProto.ts"

import { executeAgent } from "./cursorAgent.ts"
import { CursorFrameAssembler, debugLog, readCursorFrame } from "./cursorFrame.ts"

export { tailOnlyCursorMessages } from "./cursorAgent.ts"

import {
	http2,
	makeFetchRequest,
	makeHttp2Request,
	openAgentHttp2Stream,
	proxyIntentFailed,
} from "./cursorTransport.ts"

/**
 * Credentials as Cursor reads them: it only needs the client's raw headers to
 * detect a Claude Code user-agent. `Credentials` satisfies this structurally.
 */
export interface RawHeadersCredentials {
	rawHeaders?: Record<string, string>
	[key: string]: unknown
}

/** The framed ConnectRPC protobuf body Cursor expects upstream. */
export type CursorWireBody = Uint8Array

/**
 * What `transformRequest` returns. Cursor's upstream body is a framed protobuf
 * Buffer, but the base-class contract is a `ChatRequestBody`; this declares the
 * value as a buffer payload while staying assignable to that contract.
 */
export type CursorWirePayload = CursorWireBody & ChatRequestBody

/** Request options shared by `proxyAwareFetch` (a strict subset of `RequestInit`). */
export interface CursorFetchOptions {
	method: string
	headers: Record<string, string>
	body: CursorWireBody
	signal?: AbortSignal
}

/**
 * Result of an HTTP/2 request. Distinct from undici's `Response`: `status` is
 * the raw `:status` pseudo-header (hence its loose type) and `body` is a Buffer.
 */
export interface CursorHttp2Response {
	status: number | string | string[] | undefined
	headers: Record<string, string | string[] | undefined>
	body: Buffer | ReadableStream<Uint8Array>
}

function isComposerModel(model) {
	const modelId = String(model || "")
		.split("/")
		.pop()
	return /^composer(?:-|$)/i.test(modelId)
}

function visibleComposerContentFromThinking(thinking) {
	if (!thinking) return ""
	const endTag = "</think>"
	const endIdx = thinking.lastIndexOf(endTag)
	if (endIdx < 0) return ""
	return thinking.slice(endIdx + endTag.length).trimStart()
}

/** Read a body that may be a Buffer or a live stream out to text. */
async function readBodyAsText(body) {
	if (!body) return ""
	if (Buffer.isBuffer(body)) return body.toString()
	if (typeof body === "string") return body
	if (typeof body.getReader === "function") {
		const reader = body.getReader()
		const chunks = []
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(Buffer.from(value))
			}
		} finally {
			try {
				reader.releaseLock()
			} catch {
				/* already released */
			}
		}
		return Buffer.concat(chunks).toString()
	}
	return ""
}

function createErrorResponse(jsonError) {
	const errorMsg =
		jsonError?.error?.details?.[0]?.debug?.details?.title ||
		jsonError?.error?.details?.[0]?.debug?.details?.detail ||
		jsonError?.error?.message ||
		"API Error"

	const isRateLimit = jsonError?.error?.code === "resource_exhausted"

	return new Response(
		JSON.stringify({
			error: {
				message: errorMsg,
				type: isRateLimit ? "rate_limit_error" : "api_error",
				code: jsonError?.error?.details?.[0]?.debug?.error || "unknown",
			},
		}),
		{
			status: isRateLimit ? HTTP_STATUS.RATE_LIMITED : HTTP_STATUS.BAD_REQUEST,
			headers: { "Content-Type": "application/json" },
		},
	)
}

// Long-session empty-turn recovery: Cursor occasionally answers a long
// history replay with HTTP 200 and zero deltas (empty turn). One retry on a
// tail-only frame recovers the session instead of failing the client turn.

/** Wall-clock bound on the read-ahead that decides "is this a Cursor error?".
 *  An error envelope arrives in the first frame; a healthy generation that is
 *  still silent this long is not one and must not be held back. */
const CURSOR_STREAM_PRIME_MS = 5000

/**
 * The frame→SSE state machine shared by both entry points.
 *
 * `transformProtobufToSSE` (buffered) and `transformProtobufStreamToSSE` (live)
 * differ only in WHERE the frames come from. Keeping one state machine means the
 * streaming path cannot drift from the buffered one in tool-call accumulation,
 * Composer thinking scrubbing, or usage accounting - the three places this
 * decoder is subtle.
 */
class CursorSseSink {
	readonly responseId: string
	readonly created: number
	private readonly model: string
	private readonly body: Record<string, unknown>
	private readonly chunks: string[] = []
	private taken = 0
	private totalContent = ""
	private totalThinking = ""
	private emittedComposerThinkingContentLength = 0
	private readonly toolCalls: any[] = []
	private readonly toolCallsMap = new Map<string, any>()
	private readonly finalizedIds = new Set<string>()
	private readonly emittedToolCallIds = new Set<string>()
	private frameCount = 0
	private errorResponse: Response | null = null
	private halted = false

	constructor(model, body) {
		this.model = model
		this.body = body
		this.responseId = `chatcmpl-cursor-${Date.now()}`
		this.created = Math.floor(Date.now() / 1000)
	}

	/** A terminal response decided by a pre-content upstream error, if any. */
	get error(): Response | null {
		return this.errorResponse
	}
	/** True when chunks are waiting to be taken. */
	get hasEmitted(): boolean {
		return this.chunks.length > this.taken
	}
	/** True when the sink stopped early (error after content, or bad frame). */
	get stopped(): boolean {
		return this.halted
	}
	get framesSeen(): number {
		return this.frameCount
	}

	/** Chunks produced since the last call. */
	takeChunks(): string[] {
		const out = this.chunks.slice(this.taken)
		this.taken = this.chunks.length
		return out
	}

	private emit(chunk: string) {
		this.chunks.push(chunk)
	}

	/** Decode and emit one frame payload. */
	processPayload(payload: Buffer) {
		if (this.halted) return
		this.frameCount++

		// Check for JSON error frames (byte-guard: only decode if starts with '{')
		if (payload[0] === 0x7b) {
			try {
				const text = payload.toString("utf-8")
				if (text.includes('"error"')) {
					const hasContent = this.chunks.length > 0 || this.totalContent || this.toolCallsMap.size > 0
					debugLog(`[CURSOR SSE] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`)
					if (hasContent) {
						this.halted = true
						return
					}
					this.errorResponse = createErrorResponse(JSON.parse(text))
					return
				}
			} catch {}
		}

		const result = extractTextFromResponse(new Uint8Array(payload))
		debugLog(`[CURSOR DECODED SSE] Frame ${this.frameCount}:`, result)

		if (result.error) {
			const hasContent = this.chunks.length > 0 || this.totalContent || this.toolCallsMap.size > 0
			debugLog(`[CURSOR SSE] Decoded error (hasContent=${hasContent}): ${result.error}`)
			if (hasContent) {
				this.halted = true
				return
			}
			this.errorResponse = new Response(
				JSON.stringify({
					error: {
						message: result.error,
						type: "rate_limit_error",
						code: "rate_limited",
					},
				}),
				{
					status: HTTP_STATUS.RATE_LIMITED,
					headers: { "Content-Type": "application/json" },
				},
			)
			return
		}

		if (result.toolCall) {
			const tc = result.toolCall

			if (this.chunks.length === 0) {
				this.emit(
					chatChunkSse({
						id: this.responseId,
						created: this.created,
						model: this.model,
						delta: { role: "assistant", content: "" },
					}),
				)
			}

			if (this.toolCallsMap.has(tc.id)) {
				// Accumulate arguments for existing tool call
				const existing = this.toolCallsMap.get(tc.id)
				existing.function.arguments += tc.function.arguments
				existing.isLast = tc.isLast

				// Stream the delta arguments
				if (tc.function.arguments) {
					this.emittedToolCallIds.add(tc.id)
					this.emit(
						chatChunkSse({
							id: this.responseId,
							created: this.created,
							model: this.model,
							delta: {
								tool_calls: [
									{
										index: existing.index,
										id: tc.id,
										type: "function",
										function: {
											name: tc.function.name,
											arguments: tc.function.arguments,
										},
									},
								],
							},
						}),
					)
				}
			} else {
				// New tool call - assign index and add to map
				const toolCallIndex = this.toolCalls.length
				this.finalizedIds.add(tc.id)
				this.toolCalls.push({ ...tc, index: toolCallIndex })
				this.toolCallsMap.set(tc.id, { ...tc, index: toolCallIndex })

				// Stream initial tool call with name
				this.emittedToolCallIds.add(tc.id)
				this.emit(
					chatChunkSse({
						id: this.responseId,
						created: this.created,
						model: this.model,
						delta: {
							tool_calls: [
								{
									index: toolCallIndex,
									id: tc.id,
									type: "function",
									function: {
										name: tc.function.name,
										arguments: tc.function.arguments,
									},
								},
							],
						},
					}),
				)
			}
		}

		if (result.text) {
			this.totalContent += result.text
			this.emit(
				chatChunkSse({
					id: this.responseId,
					created: this.created,
					model: this.model,
					delta:
						this.chunks.length === 0 && this.toolCalls.length === 0
							? { role: "assistant", content: result.text }
							: { content: result.text },
				}),
			)
		}

		if (isComposerModel(this.model) && result.thinking) {
			this.totalThinking += result.thinking
			const visibleContent = visibleComposerContentFromThinking(this.totalThinking)
			if (visibleContent.length > this.emittedComposerThinkingContentLength) {
				const deltaContent = visibleContent.slice(this.emittedComposerThinkingContentLength)
				this.emittedComposerThinkingContentLength = visibleContent.length
				this.totalContent += deltaContent
				this.emit(
					chatChunkSse({
						id: this.responseId,
						created: this.created,
						model: this.model,
						delta:
							this.chunks.length === 0 && this.toolCalls.length === 0
								? { role: "assistant", content: deltaContent }
								: { content: deltaContent },
					}),
				)
			}
		}
	}

	/** Emit the trailing chunks: unfinished tool calls, the finish frame, `[DONE]`. */
	finalize() {
		debugLog(
			`[CURSOR SSE] Parsed ${this.frameCount} frames, toolCallsMap size: ${this.toolCallsMap.size}, toolCalls array: ${this.toolCalls.length}`,
		)

		// Finalize all remaining tool calls in map (stream may have ended without isLast=true)
		for (const [id, tc] of this.toolCallsMap.entries()) {
			if (!this.finalizedIds.has(id)) {
				debugLog(`[CURSOR SSE] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`)
				const toolCallIndex = this.toolCalls.length
				this.toolCalls.push({
					id: tc.id,
					type: tc.type,
					index: toolCallIndex,
					function: {
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				})

				// Emit SSE chunk for the finalized tool call if not already emitted
				if (!this.emittedToolCallIds.has(tc.id)) {
					this.emit(
						chatChunkSse({
							id: this.responseId,
							created: this.created,
							model: this.model,
							delta: {
								tool_calls: [
									{
										index: toolCallIndex,
										id: tc.id,
										type: "function",
										function: {
											name: tc.function.name,
											arguments: tc.function.arguments,
										},
									},
								],
							},
						}),
					)
				}
			}
		}

		if (this.chunks.length === 0 && this.toolCalls.length === 0) {
			this.emit(
				chatChunkSse({
					id: this.responseId,
					created: this.created,
					model: this.model,
					delta: { role: "assistant", content: "" },
				}),
			)
		}

		const usage = estimateUsage(this.body, this.totalContent.length, FORMATS.OPENAI)

		this.emit(
			`data: ${JSON.stringify({
				id: this.responseId,
				object: "chat.completion.chunk",
				created: this.created,
				model: this.model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: this.toolCalls.length > 0 ? "tool_calls" : "stop",
					},
				],
				usage,
			})}\n\n`,
		)
		this.emit(SSE_DONE)
	}
}

export class CursorExecutor extends BaseExecutor {
	constructor() {
		super("cursor", PROVIDERS.cursor)
	}

	buildUrl() {
		return `${this.config.baseUrl}${this.config.chatPath}`
	}

	buildHeaders(credentials) {
		const accessToken = credentials.accessToken
		const machineId = credentials.providerSpecificData?.machineId
		const ghostMode = credentials.providerSpecificData?.ghostMode !== false

		if (!machineId) {
			throw new Error("Machine ID is required for Cursor API")
		}

		return buildCursorHeaders(accessToken, machineId, ghostMode)
	}

	/**
	 * Credential context, as read by the base class. Cursor reads the client
	 * user-agent to decide Agent mode, so it keeps the widened signature; the
	 * return value is the wire body sent upstream, not a ChatRequestBody.
	 */
	transformRequest(
		model: string,
		body: ChatRequestBody,
		_stream?: boolean,
		credentials?: RawHeadersCredentials | null,
	): CursorWirePayload {
		// Messages are already translated by chatCore (claude→openai→cursor)
		// Do NOT call openaiToCursorRequest again - double-translation drops tool_results
		const messages = body.messages || []
		const tools = body.tools || []
		const reasoningEffort = body.reasoning_effort || null
		// Detect Claude Code UA to force Agent mode (issue #643)
		const ua = credentials?.rawHeaders?.["user-agent"] || ""
		const forceAgentMode =
			ua.includes("claude-cli") || ua.includes("claude-code") || ua.includes("Claude Code")
		return generateCursorBody(
			messages,
			model,
			tools,
			reasoningEffort,
			forceAgentMode,
		) as CursorWirePayload
	}

	async makeFetchRequest(url, headers, body, signal, proxyOptions = null) {
		return makeFetchRequest(url, headers, body, signal, proxyOptions)
	}

	makeHttp2Request(url, headers, body, signal) {
		return makeHttp2Request(url, headers, body, signal)
	}

	openAgentHttp2Stream(url, headers, signal) {
		return openAgentHttp2Stream(url, headers, signal)
	}

	async executeAgent(args) {
		return executeAgent({
			...args,
			buildHeaders: (c) => this.buildHeaders(c),
			openStream: (url, headers, signal) => this.openAgentHttp2Stream(url, headers, signal),
		})
	}

	async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
		if (isAgentCapableRequest(body)) {
			try {
				return await this.executeAgent({ model, body, stream, credentials, signal, log, proxyOptions })
			} catch (error) {
				return {
					response: new Response(
						JSON.stringify({
							error: { message: error.message, type: "connection_error", code: "" },
						}),
						{ status: HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } },
					),
					url: `${PROVIDER_OAUTH.cursor?.agentEndpoint || ""}${AGENT_RUN_PATH}`,
					headers: {},
					transformedBody: body,
				}
			}
		}

		const url = this.buildUrl()
		const headers = this.buildHeaders(credentials)
		const transformedBody = this.transformRequest(model, body, stream, credentials)

		try {
			const shouldForceFetch =
				proxyOptions?.enabled === true ||
				proxyOptions?.connectionProxyEnabled === true ||
				!!proxyOptions?.vercelRelayUrl
			const response =
				http2 && !shouldForceFetch
					? await this.makeHttp2Request(url, headers, transformedBody, signal)
					: await this.makeFetchRequest(url, headers, transformedBody, signal, proxyOptions)

			if (response.status !== 200) {
				// The body may now be a live stream (the fetch transport forwards it),
				// so read it out before reporting. An error body is never streamed to
				// the client, so draining it here costs nothing.
				const errorText = (await readBodyAsText(response.body)) || "Unknown error"
				const errorResponse = new Response(
					JSON.stringify({
						error: {
							message: `[${response.status}]: ${errorText}`,
							type: "invalid_request_error",
							code: "",
						},
					}),
					{
						status: Number(response.status),
						headers: { "Content-Type": "application/json" },
					},
				)
				return { response: errorResponse, url, headers, transformedBody: body }
			}

			const transformedResponse =
				stream !== false
					? await this.transformProtobufToSSEOrStream(response, model, body, signal)
					: await this.transformProtobufToJSONOrBuffered(response, model, body)

			return { response: transformedResponse, url, headers, transformedBody: body }
		} catch (error) {
			const errorResponse = new Response(
				JSON.stringify({
					error: {
						message: error.message,
						type: "connection_error",
						code: "",
					},
				}),
				{
					status: HTTP_STATUS.SERVER_ERROR,
					headers: { "Content-Type": "application/json" },
				},
			)
			return { response: errorResponse, url, headers, transformedBody: body }
		}
	}

	/**
	 * The JSON (non-streaming) path needs the whole body. The fetch transport now
	 * hands back a live stream, so drain it here - this is the one place buffering
	 * is correct, because the client asked for a single document.
	 */
	async transformProtobufToJSONOrBuffered(response, model, body) {
		const source = response?.body
		if (source && typeof source.getReader === "function") {
			const reader = source.getReader()
			const chunks = []
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					chunks.push(Buffer.from(value))
				}
			} finally {
				try {
					reader.releaseLock()
				} catch {
					/* already released */
				}
			}
			return this.transformProtobufToJSON(Buffer.concat(chunks), model, body)
		}
		return this.transformProtobufToJSON(source, model, body)
	}

	transformProtobufToJSON(buffer, model, body) {
		const responseId = `chatcmpl-cursor-${Date.now()}`
		const created = Math.floor(Date.now() / 1000)

		let offset = 0
		let totalContent = ""
		let totalThinking = ""
		const toolCalls = []
		const toolCallsMap = new Map() // Track streaming tool calls by ID
		const finalizedIds = new Set()
		let frameCount = 0

		debugLog(`[CURSOR BUFFER] Total length: ${buffer.length} bytes`)

		while (offset < buffer.length) {
			const frame = readCursorFrame(buffer, offset, frameCount, "")
			if (frame.status === "done") break
			offset = frame.offset
			frameCount++
			if (frame.status === "skip") continue
			const payload = frame.payload

			// Check for JSON error frames (byte guard: skip toString on non-JSON frames)
			if (payload.length > 0 && payload[0] === 0x7b) {
				try {
					const text = payload.toString("utf-8")
					if (text.includes('"error"')) {
						const hasContent = totalContent || toolCallsMap.size > 0
						debugLog(`[CURSOR BUFFER] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`)
						if (hasContent) {
							break
						}
						return createErrorResponse(JSON.parse(text))
					}
				} catch {}
			}

			const result = extractTextFromResponse(new Uint8Array(payload))
			debugLog(`[CURSOR DECODED] Frame ${frameCount}:`, result)

			if (result.error) {
				const hasContent = totalContent || toolCallsMap.size > 0
				debugLog(`[CURSOR BUFFER] Decoded error (hasContent=${hasContent}): ${result.error}`)
				if (hasContent) {
					break
				}
				return new Response(
					JSON.stringify({
						error: {
							message: result.error,
							type: "rate_limit_error",
							code: "rate_limited",
						},
					}),
					{
						status: HTTP_STATUS.RATE_LIMITED,
						headers: { "Content-Type": "application/json" },
					},
				)
			}

			if (result.toolCall) {
				const tc = result.toolCall

				if (toolCallsMap.has(tc.id)) {
					// Accumulate arguments for existing tool call
					const existing = toolCallsMap.get(tc.id)
					existing.function.arguments += tc.function.arguments
					existing.isLast = tc.isLast
				} else {
					// New tool call
					toolCallsMap.set(tc.id, { ...tc })
				}

				// Push to final array when isLast is true
				if (tc.isLast) {
					const finalToolCall = toolCallsMap.get(tc.id)
					finalizedIds.add(tc.id)
					toolCalls.push({
						id: finalToolCall.id,
						type: finalToolCall.type,
						function: {
							name: finalToolCall.function.name,
							arguments: finalToolCall.function.arguments,
						},
					})
				}
			}

			if (result.text) totalContent += result.text
			if (result.thinking) totalThinking += result.thinking
		}

		const visibleComposerContent = isComposerModel(model)
			? visibleComposerContentFromThinking(totalThinking)
			: ""
		const finalContent = totalContent || visibleComposerContent

		debugLog(
			`[CURSOR BUFFER] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, finalized toolCalls: ${toolCalls.length}`,
		)

		// Finalize all remaining tool calls in map (in case stream ended without isLast=true)
		for (const [id, tc] of toolCallsMap.entries()) {
			// Check if already in final array
			if (!finalizedIds.has(id)) {
				debugLog(`[CURSOR BUFFER] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`)
				toolCalls.push({
					id: tc.id,
					type: tc.type,
					function: {
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				})
			}
		}

		debugLog(`[CURSOR BUFFER] Final toolCalls count: ${toolCalls.length}`)

		const message: Record<string, unknown> = {
			role: "assistant",
			content: finalContent || null,
		}

		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls
		}

		const usage = estimateUsage(body, finalContent.length, FORMATS.OPENAI)

		const completion = {
			id: responseId,
			object: "chat.completion",
			created,
			model,
			choices: [
				{
					index: 0,
					message,
					finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
				},
			],
			usage,
		}

		return new Response(JSON.stringify(completion), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})
	}

	/**
	 * Pick the streaming path when the transport handed us a live body, and fall
	 * back to the buffered decoder when it handed us a Buffer (the h2 transport
	 * still returns a Buffer; that path keeps working unchanged).
	 */
	async transformProtobufToSSEOrStream(response, model, body, signal = null) {
		const source = response?.body
		if (source && typeof source.getReader === "function") {
			return this.transformProtobufStreamToSSE(source, model, body, signal)
		}
		return this.transformProtobufToSSE(source, model, body)
	}

	transformProtobufToSSE(buffer, model, body) {
		const sink = new CursorSseSink(model, body)
		debugLog(`[CURSOR SSE] Total length: ${buffer.length} bytes`)

		// Buffered entry point: the whole body is already in hand, so feed it through
		// the shared state machine one frame at a time. Kept for the non-streaming
		// (JSON) path and for callers that already hold the bytes.
		const assembler = new CursorFrameAssembler(" SSE")
		for (const frame of assembler.push(buffer)) {
			if (frame.status === "skip") continue
			sink.processPayload(frame.payload)
			if (sink.error) return sink.error
			if (sink.stopped) break
		}

		if (sink.error) return sink.error
		sink.finalize()
		return new Response(sink.takeChunks().join(""), {
			status: 200,
			headers: { ...SSE_HEADERS },
		})
	}

	/**
	 * Streaming entry point: forward Cursor's framed reply as SSE while it arrives.
	 *
	 * The transport used to `arrayBuffer()` the whole answer because
	 * `readCursorFrame` needs a complete frame. `CursorFrameAssembler` removes that
	 * constraint, so this returns a live `ReadableStream` and the client sees each
	 * frame as it is produced instead of waiting for the model to finish.
	 */
	transformProtobufStreamToSSE(source, model, body, signal = null) {
		const sink = new CursorSseSink(model, body)
		const assembler = new CursorFrameAssembler(" STREAM")
		const encoder = new TextEncoder()
		let reader = null

		const cancelSource = (reason) => {
			try {
				reader?.cancel?.(reason)
			} catch {
				/* already released */
			}
		}

		return new Response(
			new ReadableStream({
				start(controller) {
					if (signal) {
						const onAbort = () => cancelSource(new Error("Request aborted"))
						if (signal.aborted) onAbort()
						else signal.addEventListener("abort", onAbort, { once: true })
					}
				},
				async pull(controller) {
					// Emit anything the sink is holding before asking for more bytes.
					const flush = () => {
						for (const chunk of sink.takeChunks()) controller.enqueue(encoder.encode(chunk))
					}

					while (true) {
						if (!reader) reader = source.getReader()
						let result
						try {
							result = await reader.read()
						} catch (error) {
							controller.error(error)
							return
						}

						if (result.done) {
							// A truncated trailing frame is undecodable; drop it rather than
							// throwing away a whole answer.
							if (assembler.pendingBytes > 0) {
								debugLog(
									`[CURSOR STREAM] ${assembler.pendingBytes} trailing bytes formed no complete frame`,
								)
							}
							if (sink.error) {
								controller.error(sink.error)
								return
							}
							sink.finalize()
							flush()
							controller.close()
							return
						}

						for (const frame of assembler.push(result.value)) {
							if (frame.status === "skip") continue
							sink.processPayload(frame.payload)
							if (sink.error || sink.stopped) break
						}
						if (sink.error) {
							controller.error(sink.error)
							return
						}
						if (sink.stopped) {
							sink.finalize()
							flush()
							controller.close()
							return
						}
						// Hand over whatever this chunk produced. If it produced nothing
						// (a frame split across chunks), keep reading instead of returning:
						// returning here would stall the stream until the next pull, and
						// nothing guarantees another pull ever comes.
						if (sink.hasEmitted) {
							flush()
							return
						}
					}
				},
				cancel(reason) {
					cancelSource(reason)
				},
			}),
			{
				status: 200,
				headers: { ...SSE_HEADERS },
			},
		)
	}

	async refreshCredentials() {
		return null
	}
}

export default CursorExecutor
