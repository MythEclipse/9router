import crypto from "node:crypto"
import { PROVIDER_OAUTH } from "../config/providers.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { resolveAutoModelSelection, resolveCursorModels } from "../services/cursorModels.ts"
import { FORMATS } from "../translator/formats.ts"
import { ROLE } from "../translator/schema/index.ts"
import { decodeMcpArgs, decodeMessage } from "../utils/cursorProtobuf.ts"
import { chatChunkSse, sseChunk } from "../utils/sse.ts"
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.ts"
import { estimateUsage } from "../utils/usageTracking.ts"
import { debugLog } from "./cursorFrame.ts"
import {
	AGENT_RUN_PATH,
	agentMessage,
	buildAgentRunFrame,
	createRequestContextResponse,
	decodeAgentFrames,
	encodeKvClientMessage,
	extractAgentString,
	rejectExecRequest,
} from "./cursorProto.ts"
import { openAgentHttp2Stream, proxyIntentFailed } from "./cursorTransport.ts"

export function isComposerModel(model) {
	const modelId = String(model || "")
		.split("/")
		.pop()
	return /^composer(?:-|$)/i.test(modelId)
}

export function visibleComposerContentFromThinking(thinking) {
	if (!thinking) return ""
	const endTag = "</think>"
	const endIdx = thinking.lastIndexOf(endTag)
	if (endIdx < 0) return ""
	return thinking.slice(endIdx + endTag.length).trimStart()
}

export const CURSOR_EMPTY_TURN_MAX_RETRIES = (() => {
	const value = Number(process.env.CURSOR_EMPTY_TURN_MAX_RETRIES)
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1
})()

export const CURSOR_TAIL_ONLY_THRESHOLD = (() => {
	const value = Number(process.env.CURSOR_TAIL_ONLY_THRESHOLD)
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 80
})()

export const CURSOR_EMPTY_TURN_RETRY_DELAY_MS = (() => {
	const value = Number(process.env.CURSOR_EMPTY_TURN_RETRY_DELAY_MS)
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 400
})()

/** Minimal tail for wedged long sessions — drops bulk history and tool XML. */

/** Minimal tail for wedged long sessions — drops bulk history and tool XML. */
export function tailOnlyCursorMessages(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return messages || []
	const systemMessages = messages.filter(
		(message) =>
			message?.role === ROLE.SYSTEM && !String(message?.content || "").includes("[9router]"),
	)
	const chatMessages = messages.filter((message) => message?.role !== ROLE.SYSTEM)
	let anchor = chatMessages.length - 1
	for (let i = chatMessages.length - 1; i >= 0; i--) {
		if (chatMessages[i]?.role === ROLE.USER || chatMessages[i]?.role === ROLE.TOOL) {
			anchor = i
			break
		}
	}
	const tailStart =
		anchor > 0 && chatMessages[anchor - 1]?.role === ROLE.ASSISTANT ? anchor - 1 : anchor
	const tail = chatMessages.slice(Math.max(0, tailStart))
	const note = {
		role: ROLE.SYSTEM,
		content: `[9router] Long session: ${messages.length} messages trimmed to the latest turn. Answer the current request; re-read files if needed.`,
	}
	return [...systemMessages, note, ...tail]
}

/**
 * Retry an empty AgentService turn only when a long-session replay is the
 * likely cause: upstream accepts the request, streams HTTP 200, and closes
 * with zero deltas. A first-message empty turn is a protocol condition, not
 * a wedged replay, and must surface to the client without retry.
 */
export function shouldRetryEmptyTurn(messageCount) {
	return messageCount >= CURSOR_TAIL_ONLY_THRESHOLD
}

export async function executeAgent({
	model,
	body,
	stream,
	credentials,
	signal,
	log,
	proxyOptions = null,
	buildHeaders,
}: any) {
	const agentEndpoint = PROVIDER_OAUTH.cursor?.agentEndpoint
	if (!agentEndpoint) throw new Error("Cursor AgentService endpoint is not configured")

	// Policy guard: the h2 duplex stream below cannot ride a proxy, so a
	// strict proxy configuration must fail closed here rather than leak the
	// real IP on a direct socket (see proxyIntentFailed above).
	if (proxyIntentFailed(proxyOptions)) {
		throw new Error(
			"Cursor AgentService requires a strict proxy that this HTTP/2 transport cannot honor; refusing to open a direct connection",
		)
	}

	const url = `${agentEndpoint}${AGENT_RUN_PATH}`
	const headers = buildHeaders(credentials)
	const requestController = new AbortController()
	if (signal?.addEventListener) {
		signal.addEventListener("abort", () => requestController.abort(signal.reason), { once: true })
	}

	// Empty-turn recovery works on the original client history so each retry
	// re-derives its own frame from a clean base (original vs tail-only).
	const originalMessages = body.messages || []
	let workingMessages = originalMessages
	const tools = body.tools || []
	// "Auto (Server Picks)" / "default" is a picker alias, not an AgentService
	// model id — sending it verbatim yields an empty turn. Resolve it to the
	// account's default agent-capable model from the live catalog before Run.
	let runModel = model
	if (model === "default" || model === "auto") {
		const catalog = await resolveCursorModels(credentials, { signal, log })
		const selection = resolveAutoModelSelection(catalog?.models)
		if (selection) {
			log?.info?.(
				"CURSOR",
				`auto model resolved: ${model} → ${selection.modelId} (${selection.matchedBy})`,
			)
			runModel = selection.modelId
		}
	}

	const openAgentSession = (frameMessages) => {
		const session = openAgentHttp2Stream(url, headers, requestController.signal)
		session.write(
			buildAgentRunFrame(
				frameMessages,
				runModel,
				tools,
				body.reasoning_effort || body.reasoning?.effort,
			),
		)
		return session
	}

	let session
	try {
		session = openAgentSession(workingMessages)
	} catch (error) {
		throw new Error(`Cursor AgentService request failed: ${error.message}`)
	}
	let responseHeaders
	try {
		responseHeaders = await session.responseHeaders
	} catch (error) {
		session.close()
		throw new Error(`Cursor AgentService request failed: ${error.message}`)
	}

	const status = Number(responseHeaders[":status"] || 0)
	if (status !== 200) {
		let errorText = ""
		try {
			while (true) {
				const { done, value } = await session.read()
				if (done) break
				errorText += Buffer.from(value).toString("utf8")
			}
		} catch {}
		session.close()
		return {
			response: new Response(
				JSON.stringify({
					error: {
						message: `Cursor AgentService ${status}: ${errorText || "request failed"}`,
						type: "api_error",
					},
				}),
				{
					status: status || HTTP_STATUS.SERVER_ERROR,
					headers: { "Content-Type": "application/json" },
				},
			),
			url,
			headers,
			transformedBody: body,
			responseFormat: FORMATS.OPENAI,
		}
	}

	// The Claude SSE translator derives Anthropic's message ID by stripping
	// `chatcmpl-`. Keep the remaining ID in Anthropic's required `msg_` form
	// so strict clients such as Claude Code accept the completed stream.
	const responseId = `chatcmpl-msg_${Date.now()}`
	const created = Math.floor(Date.now() / 1000)
	const composerModel = isComposerModel(model)
	let pending = Buffer.alloc(0)
	let finished = false
	let thinkingAcc = ""
	let emittedVisible = 0
	let emittedText = false

	const flushThinkingFallback = (onEvent) => {
		if (emittedText || !thinkingAcc) return
		const fallback = composerModel
			? visibleComposerContentFromThinking(thinkingAcc)
			: thinkingAcc.trim()
		if (fallback) {
			emittedText = true
			onEvent({ type: "text", value: fallback })
		}
	}

	const consume = async (onEvent) => {
		const finishTurn = () => {
			flushThinkingFallback(onEvent)
			finished = true
			if (emittedText) onEvent({ type: "done" })
			else onEvent({ type: "error", value: "Cursor AgentService returned an empty turn" })
		}
		try {
			while (!finished) {
				const { done, value } = await session.read()
				if (done) break
				pending = Buffer.concat([pending, Buffer.from(value)])
				pending = decodeAgentFrames(pending, (payload) => {
					// A single read can carry several frames; once the turn is over the
					// rest of the batch must not reach the already-closed controller.
					if (finished) return
					const serverMessage = decodeMessage(payload)

					// agent.v1.AgentServerMessage.interaction_update
					if (serverMessage.has(1)) {
						const update = decodeMessage(serverMessage.get(1)[0].value)
						if (update.has(1)) {
							const textDelta = extractAgentString(decodeMessage(update.get(1)[0].value), 1)
							if (textDelta) {
								emittedText = true
								onEvent({ type: "text", value: textDelta })
							}
						}
						// thinking_delta (field 4). Composer (and some Grok variants) put
						// the visible answer after </think> here and never send text_delta.
						if (update.has(4)) {
							const thinkingDelta = extractAgentString(decodeMessage(update.get(4)[0].value), 1)
							if (thinkingDelta) {
								thinkingAcc += thinkingDelta
								if (composerModel) {
									const visible = visibleComposerContentFromThinking(thinkingAcc)
									if (visible.length > emittedVisible) {
										const deltaContent = visible.slice(emittedVisible)
										emittedVisible = visible.length
										emittedText = true
										onEvent({ type: "text", value: deltaContent })
									}
								}
							}
						}
						// Keep unsigned reasoning upstream-only for Anthropic clients.
						if (update.has(14)) {
							finishTurn()
						}
					}

					// KvServerMessage (field 4): get/set blob. Ack so the stream proceeds.
					if (serverMessage.has(4)) {
						const kv = decodeMessage(serverMessage.get(4)[0].value)
						const kvId = kv.get(1)?.[0]?.value || 0
						const metadata = kv.get(4)?.[0]?.value || null
						if (kv.has(2)) {
							session.write(encodeKvClientMessage(kvId, 2, agentMessage(1, new Uint8Array()), metadata))
						} else if (kv.has(3)) {
							session.write(encodeKvClientMessage(kvId, 3, new Uint8Array(), metadata))
						}
					}

					// AgentService requests IDE context before producing a response.
					if (serverMessage.has(2)) {
						const execRequest = decodeMessage(serverMessage.get(2)[0].value)
						if (execRequest.has(10)) {
							log?.info?.("CURSOR", "AgentService request_context ack")
							session.write(createRequestContextResponse(execRequest))
						} else if (execRequest.has(11)) {
							const mcp = decodeMcpArgs(execRequest.get(11)[0].value)
							const name = mcp.toolName || mcp.name
							if (name) {
								log?.info?.("CURSOR", `AgentService MCP tool_call ${name}`)
								finished = true
								onEvent({
									type: "tool_call",
									value: {
										id: mcp.toolCallId || `call_${crypto.randomUUID()}`,
										name,
										arguments: JSON.stringify(mcp.args || {}),
									},
								})
								onEvent({ type: "done", finishReason: "tool_calls" })
							} else {
								debugLog(
									`[CURSOR AGENT] Unsupported exec request fields: ${[...execRequest.keys()].join(",")}`,
								)
								finished = true
								onEvent({ type: "error", value: "Cursor AgentService requested an unsupported IDE tool" })
							}
						} else {
							// Auto/Composer often probe IDE builtins (shell/read/…). Reject
							// them so the model can continue with MCP tools or a text answer
							// instead of stalling the h2 stream.
							const rejection = rejectExecRequest(execRequest)
							if (rejection) {
								log?.info?.(
									"CURSOR",
									`AgentService rejected IDE exec fields=${[...execRequest.keys()].join(",")}`,
								)
								session.write(rejection)
							} else {
								debugLog(
									`[CURSOR AGENT] Unsupported exec request fields: ${[...execRequest.keys()].join(",")}`,
								)
								finished = true
								onEvent({ type: "error", value: "Cursor AgentService requested an unsupported IDE tool" })
							}
						}
					}
				})
			}
			if (!finished) finishTurn()
		} finally {
			try {
				session.end()
			} catch {}
			try {
				session.close()
			} catch {}
		}
	}

	// One AgentService attempt on the current working frame. Returns sawContent
	// so the retry policy can tell a wedged long replay from a protocol empty.
	const runAgentTurn = async (onEvent) => {
		finished = false
		emittedText = false
		thinkingAcc = ""
		emittedVisible = 0
		pending = Buffer.alloc(0)
		await consume(onEvent)
		return { sawContent: emittedText }
	}

	// Wrap events so we never retry once real output has reached the client.
	let outputStarted = false
	const makeWrappedEvent = (onEvent) => (event) => {
		if (event.type === "text" || event.type === "thinking" || event.type === "tool_call")
			outputStarted = true
		onEvent(event)
	}

	// Retry loop: fresh h2 session per attempt. An empty turn on a long replay
	// swaps to a tail-only frame; any other failure surfaces immediately.
	// While a retry is still available the empty-turn error event is withheld:
	// emitting it would close the SSE stream before recovery can run.
	const runWithRetry = async (onEvent) => {
		outputStarted = false
		const wrapped = makeWrappedEvent(onEvent)
		let attempt = 0
		for (;;) {
			let turnError = null
			const result = await runAgentTurn((event) => {
				if (event.type === "error") turnError = event
				else wrapped(event)
			})
			if (
				turnError &&
				shouldRetryEmptyTurn(originalMessages.length) &&
				!outputStarted &&
				attempt < CURSOR_EMPTY_TURN_MAX_RETRIES &&
				!requestController.signal.aborted
			) {
				attempt++
				log?.info?.(
					"CURSOR",
					`empty_turn on ${originalMessages.length}-message session; retry ${attempt}/${CURSOR_EMPTY_TURN_MAX_RETRIES} with tail-only frame`,
				)
				workingMessages = tailOnlyCursorMessages(originalMessages)
				session = openAgentSession(workingMessages)
				const retryHeaders = await session.responseHeaders
				const retryStatus = Number(retryHeaders[":status"] || 0)
				if (retryStatus !== 200) {
					wrapped(turnError)
					return result
				}
				await new Promise((resolve) => setTimeout(resolve, CURSOR_EMPTY_TURN_RETRY_DELAY_MS))
				continue
			}
			if (turnError) wrapped(turnError)
			return result
		}
	}

	if (stream === false) {
		let content = ""
		let reasoning = ""
		let agentError = null
		const toolCalls = []
		let finishReason = "stop"
		await runWithRetry((event) => {
			if (event.type === "text") content += event.value
			else if (event.type === "thinking") reasoning += event.value
			else if (event.type === "tool_call") {
				toolCalls.push({
					id: event.value.id,
					type: "function",
					function: { name: event.value.name, arguments: event.value.arguments },
				})
				finishReason = "tool_calls"
			} else if (event.type === "error") agentError = event.value
			else if (event.type === "done" && event.finishReason) finishReason = event.finishReason
		})
		if (agentError) {
			return {
				response: new Response(JSON.stringify({ error: { message: agentError, type: "api_error" } }), {
					status: HTTP_STATUS.BAD_REQUEST,
					headers: { "Content-Type": "application/json" },
				}),
				url,
				headers,
				transformedBody: body,
				responseFormat: FORMATS.OPENAI,
			}
		}
		const message = {
			role: "assistant",
			content: content || null,
			...(reasoning ? { reasoning_content: reasoning } : {}),
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		}
		return {
			response: new Response(
				JSON.stringify({
					id: responseId,
					object: "chat.completion",
					created,
					model,
					choices: [{ index: 0, message, finish_reason: finishReason }],
					usage: estimateUsage(body, content.length, FORMATS.OPENAI),
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
			url,
			headers,
			transformedBody: body,
			responseFormat: FORMATS.OPENAI,
		}
	}

	const encoder = new TextEncoder()
	const responseStream = new ReadableStream({
		start(controller) {
			// Defer terminal SSE until runWithRetry settles. Emitting stop on the
			// first empty upstream turn wedges Cursor before the tail-only retry
			// can recover the session.
			runWithRetry((event) => {
				if (event.type === "text") {
					controller.enqueue(
						encoder.encode(
							chatChunkSse({ id: responseId, created, model, delta: { content: event.value } }),
						),
					)
				} else if (event.type === "thinking") {
					controller.enqueue(
						encoder.encode(
							chatChunkSse({ id: responseId, created, model, delta: { reasoning_content: event.value } }),
						),
					)
				} else if (event.type === "tool_call") {
					controller.enqueue(
						encoder.encode(
							chatChunkSse({
								id: responseId,
								created,
								model,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: event.value.id,
											type: "function",
											function: { name: event.value.name, arguments: event.value.arguments },
										},
									],
								},
							}),
						),
					)
				} else if (event.type === "error") {
					// An SSE error frame, not a content delta: a protocol failure must not
					// be rendered to the user as the assistant's reply, and downstream
					// usage tracking must not record the turn as a success.
					controller.enqueue(
						encoder.encode(sseChunk({ error: { message: event.value, type: "api_error" } })),
					)
					controller.enqueue(encoder.encode(SSE_DONE))
					controller.close()
				} else if (event.type === "done") {
					controller.enqueue(
						encoder.encode(
							chatChunkSse({
								id: responseId,
								created,
								model,
								delta: {},
								finishReason: event.finishReason || "stop",
							}),
						),
					)
					controller.enqueue(encoder.encode(SSE_DONE))
					controller.close()
				}
			}).catch((error) => controller.error(error))
		},
		cancel() {
			requestController.abort()
		},
	})

	return {
		response: new Response(responseStream, { headers: SSE_HEADERS }),
		url,
		headers,
		transformedBody: body,
		responseFormat: FORMATS.OPENAI,
	}
}
