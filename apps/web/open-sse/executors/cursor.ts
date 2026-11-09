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
import { debugLog, readCursorFrame } from "./cursorFrame.ts"

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
	body: Buffer
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
		return executeAgent({ ...args, buildHeaders: (c) => this.buildHeaders(c) })
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
				const errorText = response.body?.toString() || "Unknown error"
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
					? this.transformProtobufToSSE(response.body, model, body)
					: this.transformProtobufToJSON(response.body, model, body)

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

	transformProtobufToSSE(buffer, model, body) {
		const responseId = `chatcmpl-cursor-${Date.now()}`
		const created = Math.floor(Date.now() / 1000)

		const chunks = []
		let offset = 0
		let totalContent = ""
		let totalThinking = ""
		let emittedComposerThinkingContentLength = 0
		const toolCalls = []
		const toolCallsMap = new Map() // Track streaming tool calls by ID
		const finalizedIds = new Set()
		const emittedToolCallIds = new Set()
		let frameCount = 0

		debugLog(`[CURSOR BUFFER SSE] Total length: ${buffer.length} bytes`)

		while (offset < buffer.length) {
			const frame = readCursorFrame(buffer, offset, frameCount, " SSE")
			if (frame.status === "done") break
			offset = frame.offset
			frameCount++
			if (frame.status === "skip") continue
			const payload = frame.payload

			// Check for JSON error frames (byte-guard: only decode if starts with '{')
			if (payload[0] === 0x7b) {
				try {
					const text = payload.toString("utf-8")
					if (text.includes('"error"')) {
						const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0
						debugLog(`[CURSOR BUFFER SSE] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`)
						if (hasContent) {
							break
						}
						return createErrorResponse(JSON.parse(text))
					}
				} catch {}
			}

			const result = extractTextFromResponse(new Uint8Array(payload))
			debugLog(`[CURSOR DECODED SSE] Frame ${frameCount}:`, result)

			if (result.error) {
				const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0
				debugLog(`[CURSOR BUFFER SSE] Decoded error (hasContent=${hasContent}): ${result.error}`)
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

				if (chunks.length === 0) {
					chunks.push(
						chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }),
					)
				}

				if (toolCallsMap.has(tc.id)) {
					// Accumulate arguments for existing tool call
					const existing = toolCallsMap.get(tc.id)
					const _oldArgsLen = existing.function.arguments.length
					existing.function.arguments += tc.function.arguments
					existing.isLast = tc.isLast

					// Stream the delta arguments
					if (tc.function.arguments) {
						emittedToolCallIds.add(tc.id)
						chunks.push(
							chatChunkSse({
								id: responseId,
								created,
								model,
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
					const toolCallIndex = toolCalls.length
					finalizedIds.add(tc.id)
					toolCalls.push({ ...tc, index: toolCallIndex })
					toolCallsMap.set(tc.id, { ...tc, index: toolCallIndex })

					// Stream initial tool call with name
					emittedToolCallIds.add(tc.id)
					chunks.push(
						chatChunkSse({
							id: responseId,
							created,
							model,
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
				totalContent += result.text
				chunks.push(
					chatChunkSse({
						id: responseId,
						created,
						model,
						delta:
							chunks.length === 0 && toolCalls.length === 0
								? { role: "assistant", content: result.text }
								: { content: result.text },
					}),
				)
			}

			if (isComposerModel(model) && result.thinking) {
				totalThinking += result.thinking
				const visibleContent = visibleComposerContentFromThinking(totalThinking)
				if (visibleContent.length > emittedComposerThinkingContentLength) {
					const deltaContent = visibleContent.slice(emittedComposerThinkingContentLength)
					emittedComposerThinkingContentLength = visibleContent.length
					totalContent += deltaContent
					chunks.push(
						chatChunkSse({
							id: responseId,
							created,
							model,
							delta:
								chunks.length === 0 && toolCalls.length === 0
									? { role: "assistant", content: deltaContent }
									: { content: deltaContent },
						}),
					)
				}
			}
		}

		debugLog(
			`[CURSOR BUFFER SSE] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, toolCalls array: ${toolCalls.length}`,
		)

		// Finalize all remaining tool calls in map (stream may have ended without isLast=true)
		for (const [id, tc] of toolCallsMap.entries()) {
			if (!finalizedIds.has(id)) {
				debugLog(`[CURSOR BUFFER SSE] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`)
				const toolCallIndex = toolCalls.length
				toolCalls.push({
					id: tc.id,
					type: tc.type,
					index: toolCallIndex,
					function: {
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				})

				// Emit SSE chunk for the finalized tool call if not already emitted
				if (!emittedToolCallIds.has(tc.id)) {
					chunks.push(
						chatChunkSse({
							id: responseId,
							created,
							model,
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

		if (chunks.length === 0 && toolCalls.length === 0) {
			chunks.push(
				chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }),
			)
		}

		const usage = estimateUsage(body, totalContent.length, FORMATS.OPENAI)

		chunks.push(
			`data: ${JSON.stringify({
				id: responseId,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
					},
				],
				usage,
			})}\n\n`,
		)
		chunks.push(SSE_DONE)

		return new Response(chunks.join(""), {
			status: 200,
			headers: { ...SSE_HEADERS },
		})
	}

	async refreshCredentials() {
		return null
	}
}

export default CursorExecutor
