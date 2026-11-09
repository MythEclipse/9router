import { crc32, parseEventFrame } from "../utils/awsEventStream.ts"
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.ts"
import { estimateInputTokens } from "../utils/usageTracking.ts"
import type { KiroStreamTransformOptions } from "./kiroStream.ts"
import {
	EVENTSTREAM_MAX_HEADERS_BYTES,
	EVENTSTREAM_MAX_MESSAGE_BYTES,
	encoder,
	encodeSSEError,
	KIRO_EVENT_TYPES,
	KIRO_TRUNCATION_STOP_REASONS,
	mergeStopReason,
	normalizeStopReason,
	readKiroTokenUsage,
	stopDisposition,
} from "./kiroStream.ts"
import { createKiroTransformContext } from "./kiroTransformState.ts"

export function transformEventStreamToSSE(
	response: Response,
	model: string,
	options: KiroStreamTransformOptions = {},
) {
	const {
		state,
		eventCounts,
		diagnostics,
		sseChunk,
		emitDelta,
		fail,
		assertToolBufferBound,
		appendToolInput,
		parsedToolInput,
		emitTools,
		responseId,
		created,
	} = createKiroTransformContext(model, options)
	const processEvent = (event, controller) => {
		const messageType = event.headers[":message-type"]
		if (messageType === "error" || messageType === "exception") {
			fail(
				controller,
				"upstream_eventstream_error",
				"kiro_upstream_eventstream_error",
				event.payload?.message || `Kiro upstream sent an EventStream ${messageType}`,
				{ transport_state: "upstream_error" },
			)
			return false
		}

		const eventType = event.headers[":event-type"] || ""
		const eventCountKey = KIRO_EVENT_TYPES.has(eventType) ? eventType : "other"
		eventCounts[eventCountKey] = (eventCounts[eventCountKey] || 0) + 1
		if (eventType === "assistantResponseEvent" && typeof event.payload?.content === "string") {
			let content = event.payload.content
			if (state.inThinking) {
				const end = content.indexOf("</thinking>")
				if (end < 0) content = ""
				else {
					state.inThinking = false
					content = content.slice(end + 11).replace(/^\n/u, "")
				}
			} else {
				const start = content.indexOf("<thinking>")
				if (start >= 0) {
					const end = content.indexOf("</thinking>", start + 10)
					if (end < 0) {
						state.inThinking = true
						content = content.slice(0, start)
					} else {
						content = content.slice(0, start) + content.slice(end + 11).replace(/^\n/u, "")
					}
				}
			}
			if (content || !state.hasReasoning) {
				state.hasText ||= content.length > 0
				state.totalContentLength += content.length
				emitDelta(controller, { content })
			}
		} else if (eventType === "reasoningContentEvent") {
			const value = event.payload?.reasoningContentEvent || event.payload || {}
			const content = typeof value === "string" ? value : value.text || value.content || ""
			if (content) {
				state.hasReasoning = true
				state.totalContentLength += content.length
				emitDelta(controller, { reasoning_content: content })
			}
		} else if (eventType === "codeEvent" && typeof event.payload?.content === "string") {
			state.hasCode = true
			state.totalContentLength += event.payload.content.length
			emitDelta(controller, { content: event.payload.content })
		} else if (eventType === "toolUseEvent") {
			state.sawToolUse = true
			const values = Array.isArray(event.payload) ? event.payload : [event.payload]
			if (!values[0]) throw new Error("Kiro toolUseEvent is empty")
			for (const value of values) {
				const name = typeof value?.name === "string" ? value.name.trim() : ""
				if (!name) throw new Error("Kiro toolUseEvent is missing a tool name")
				let id
				if (value.toolUseId == null) {
					id = `call_${created}_${state.tools.size + 1}`
				} else if (typeof value.toolUseId !== "string" || !value.toolUseId.trim()) {
					throw new Error("Kiro toolUseEvent has an invalid toolUseId")
				} else {
					id = value.toolUseId
				}
				let tool = state.tools.get(id)
				if (!tool) {
					tool = { id, name }
					state.tools.set(id, tool)
					state.bufferedToolBytes += encoder.encode(id).byteLength + encoder.encode(name).byteLength + 32
					assertToolBufferBound()
				} else if (tool.name !== name) {
					throw new Error("Kiro tool name changed between fragments")
				}
				appendToolInput(tool, value.input)
			}
		} else if (eventType === "messageStopEvent") {
			state.explicitStop = true
			const reason =
				normalizeStopReason(event.payload?.stopReason ?? event.payload?.stop_reason) ||
				(state.sawToolUse ? "tool_use" : "end_turn")
			const merged = mergeStopReason(state.stopReason, reason)
			if (merged !== state.stopReason) state.terminalProvenance = "message_stop_event"
			state.stopReason = merged
		} else if (
			eventType === "metadataEvent" ||
			eventType === "MetadataEvent" ||
			eventType === "messageMetadataEvent"
		) {
			const metadata = event.payload?.metadataEvent || event.payload?.metadata || event.payload
			const reason = normalizeStopReason(metadata?.stopReason ?? metadata?.stop_reason)
			if (reason) {
				state.explicitStop = true
				const merged = mergeStopReason(state.stopReason, reason)
				if (merged !== state.stopReason) state.terminalProvenance = "metadata_stop_reason"
				state.stopReason = merged
			}
			// The terminal metadataEvent carries Kiro's real token accounting under
			// `tokenUsage`. Read it here: the percentage estimator below is a last
			// resort, and must never overwrite a count the provider actually sent.
			const native = readKiroTokenUsage(metadata?.tokenUsage ?? metadata)
			if (native) {
				state.usage = { ...(state.usage || {}), ...native }
				state.hasNativeUsage = true
			}
		} else if (eventType === "contextUsageEvent") {
			const percentage = Number(event.payload?.contextUsagePercentage)
			if (Number.isFinite(percentage)) {
				state.contextUsagePercentage = percentage
				state.hasContextUsage = true
			}
		} else if (eventType === "meteringEvent") {
			state.hasMetering = true
			const metering = event.payload?.meteringEvent || event.payload || {}
			const credits = Number(metering.usage)
			if (Number.isFinite(credits)) {
				state.usage = {
					...(state.usage || {}),
					kiro_credits: credits,
					kiro_credit_unit: typeof metering.unit === "string" ? metering.unit : "credit",
				}
			}
		} else if (eventType === "metricsEvent") {
			const metrics = event.payload?.metricsEvent || event.payload || {}
			const prompt = Number(metrics.inputTokens) || 0
			const completion = Number(metrics.outputTokens) || 0
			if (prompt || completion) {
				state.usage = {
					...(state.usage || {}),
					prompt_tokens: prompt,
					completion_tokens: completion,
					total_tokens: prompt + completion,
				}
				const cacheRead = Number(metrics.cacheReadInputTokens || metrics.cache_read_input_tokens) || 0
				const cacheCreate =
					Number(metrics.cacheCreationInputTokens || metrics.cache_creation_input_tokens) || 0
				if (cacheRead) state.usage.cache_read_input_tokens = cacheRead
				if (cacheCreate) state.usage.cache_creation_input_tokens = cacheCreate
				state.hasNativeUsage = true
			}
		}
		return true
	}
	const processBytes = (chunk, controller) => {
		const combinedLength = state.buffer.byteLength + chunk.byteLength
		if (combinedLength > (options.maxRawBytes || EVENTSTREAM_MAX_MESSAGE_BYTES)) {
			fail(
				controller,
				"corrupt_eventstream_frame",
				"kiro_missing_terminal",
				"Kiro EventStream buffered bytes exceed the protocol bound",
			)
			return false
		}
		if (state.buffer.byteLength === 0) {
			state.buffer = chunk
		} else {
			const joined = new Uint8Array(combinedLength)
			joined.set(state.buffer)
			joined.set(chunk, state.buffer.byteLength)
			state.buffer = joined
		}

		while (state.buffer.byteLength >= 12) {
			const view = new DataView(state.buffer.buffer, state.buffer.byteOffset)
			if (view.getUint32(8, false) !== crc32(state.buffer.subarray(0, 8))) {
				fail(
					controller,
					"corrupt_eventstream_frame",
					"kiro_missing_terminal",
					"Kiro EventStream prelude CRC mismatch",
				)
				return false
			}
			const totalLength = view.getUint32(0, false)
			const headersLength = view.getUint32(4, false)
			if (
				totalLength < 16 ||
				totalLength > EVENTSTREAM_MAX_MESSAGE_BYTES ||
				headersLength > EVENTSTREAM_MAX_HEADERS_BYTES ||
				headersLength > totalLength - 16
			) {
				fail(
					controller,
					"corrupt_eventstream_frame",
					"kiro_missing_terminal",
					"Kiro EventStream frame bounds are invalid",
				)
				return false
			}
			if (state.buffer.byteLength < totalLength) break
			const frame = state.buffer.slice(0, totalLength)
			state.buffer = state.buffer.slice(totalLength)
			let event
			try {
				event = parseEventFrame(frame)
			} catch (error) {
				fail(controller, "corrupt_eventstream_frame", "kiro_missing_terminal", error.message)
				return false
			}
			state.transportState = "valid_complete_frame"
			state.validatedFrames++
			try {
				if (!processEvent(event, controller)) return false
			} catch (error) {
				const bufferExceeded = error.code === "KIRO_BUFFER_EXCEEDED"
				if (!bufferExceeded) {
					// Keep whatever is already buffered: the rejected fragment belongs to
					// one tool, and clearing the map dropped the complete calls too.
					state.toolValidationError ||= error.message
					console.error(
						`[Kiro] tool fragment rejected, keeping ${state.tools.size} buffered tool(s): ${error.message}`,
					)
					continue
				}
				fail(controller, "integrity_buffer_exceeded", "kiro_integrity_buffer_exceeded", error.message, {
					transport_state: state.transportState,
					stop_disposition: "terminal_incomplete",
				})
				return false
			}
		}
		return true
	}
	const finish = (controller) => {
		if (state.finished) return
		if (state.buffer.byteLength) {
			fail(
				controller,
				"incomplete_eventstream_frame",
				"kiro_missing_terminal",
				"Kiro EventStream ended with a truncated frame",
				{ transport_state: "incomplete_frame" },
			)
			return
		}
		state.transportState = "clean_eof"
		const declaredDisposition = stopDisposition(state.stopReason, state.sawToolUse)
		// model_context_window_exceeded / max_tokens map to terminal_incomplete. When
		// they arrive after the model already streamed content, fail() threw away a
		// complete-enough answer; a truncated turn is what finish_reason "length" is
		// for. chunkIndex > 0 means at least one delta already reached the client.
		const declaredTruncatedAfterOutput =
			declaredDisposition === "terminal_incomplete" &&
			KIRO_TRUNCATION_STOP_REASONS.has(state.stopReason) &&
			state.chunkIndex > 0
		if (declaredTruncatedAfterOutput) {
			console.error(
				`[Kiro] truncated after ${state.chunkIndex} chunk(s) (stop_reason=${state.stopReason}); keeping output`,
			)
		}
		if (
			!declaredTruncatedAfterOutput &&
			[
				"retryable_protocol_failure",
				"terminal_incomplete",
				"terminal_refusal",
				"unknown_failure",
			].includes(declaredDisposition)
		) {
			const code =
				declaredDisposition === "retryable_protocol_failure"
					? "kiro_retryable_protocol_failure"
					: declaredDisposition === "terminal_refusal"
						? "kiro_terminal_refusal"
						: declaredDisposition === "terminal_incomplete"
							? "kiro_terminal_incomplete"
							: "kiro_unknown_stop_reason"
			fail(
				controller,
				state.terminalProvenance || "metadata_stop_reason",
				code,
				`Kiro ended with non-success stop reason: ${state.stopReason}`,
				{ transport_state: state.transportState, stop_disposition: declaredDisposition },
			)
			return
		}
		try {
			emitTools(controller)
		} catch (error) {
			fail(controller, "invalid_tool_call", "invalid_kiro_tool_call", error.message, {
				transport_state: state.transportState,
				stop_disposition: "retryable_protocol_failure",
			})
			return
		}
		// Fail only when the turn has nothing usable left. emitTools() validates
		// per tool and drops just the unusable ones, so this has to run AFTER it:
		// before, the rejected tool was still buffered and tools.size was never 0.
		// A turn that also produced text keeps that text -- the dropped call is
		// logged, not fatal.
		if (
			state.toolValidationError &&
			!state.hasToolCalls &&
			!state.hasText &&
			!state.hasReasoning &&
			!state.hasCode
		) {
			fail(controller, "invalid_tool_call", "invalid_kiro_tool_call", state.toolValidationError, {
				transport_state: state.transportState,
				stop_disposition: "retryable_protocol_failure",
			})
			return
		}

		const hasOutput = state.hasText || state.hasReasoning || state.hasCode || state.hasToolCalls
		if (!hasOutput && !state.explicitStop) {
			fail(
				controller,
				"empty_response_eof",
				"kiro_missing_terminal",
				"Kiro EventStream ended without model output",
				{ transport_state: state.transportState },
			)
			return
		}

		const disposition = stopDisposition(state.stopReason, state.hasToolCalls)
		// Same reasoning as declaredTruncatedAfterOutput above.
		const truncatedAfterOutput =
			disposition === "terminal_incomplete" &&
			KIRO_TRUNCATION_STOP_REASONS.has(state.stopReason) &&
			state.chunkIndex > 0
		if (truncatedAfterOutput) {
			console.error(
				`[Kiro] truncated after ${state.chunkIndex} chunk(s) (stop_reason=${state.stopReason}); closing as length`,
			)
		}
		if (
			!truncatedAfterOutput &&
			[
				"retryable_protocol_failure",
				"terminal_incomplete",
				"terminal_refusal",
				"unknown_failure",
			].includes(disposition)
		) {
			const code =
				disposition === "retryable_protocol_failure"
					? "kiro_retryable_protocol_failure"
					: disposition === "terminal_refusal"
						? "kiro_terminal_refusal"
						: disposition === "terminal_incomplete"
							? "kiro_terminal_incomplete"
							: "kiro_unknown_stop_reason"
			fail(
				controller,
				state.terminalProvenance || "metadata_stop_reason",
				code,
				`Kiro ended with non-success stop reason: ${state.stopReason}`,
				{ transport_state: state.transportState, stop_disposition: disposition },
			)
			return
		}

		// Last-resort estimate. Kiro reports context usage as a PERCENTAGE of the
		// model's advertised window, not a token count. Never turn that percentage
		// into tokens via `contextUsagePercentage * contextWindow / 100` — on a
		// 1M-context model a short conversation would be logged as ~500k input
		// tokens for a few thousand real ones. When the stream carried no native
		// usage, estimate from the bytes we actually saw instead of the window.
		if (!state.hasNativeUsage && state.hasContextUsage && !state.usage?.total_tokens) {
			const content = state.totalContentLength || 0
			const completion = content ? Math.max(1, Math.floor(content / 4)) : 0
			const requestBody = options?.requestBody || {}
			const prompt = Math.max(1, estimateInputTokens(requestBody))
			// Native Kiro usage is absent, but the original request body is a better
			// prompt-side estimate than reusing the output bytes. Reusing the same
			// value for both prompt and completion created the mirrored counts seen in
			// the production Kiro usage feed.
			state.usage = {
				...(state.usage || {}),
				prompt_tokens: prompt,
				completion_tokens: completion,
				total_tokens: prompt + completion,
				estimated: true,
			}
		}
		const finishReason = truncatedAfterOutput
			? "length"
			: state.hasToolCalls
				? "tool_calls"
				: disposition === "length"
					? "length"
					: "stop"
		controller.enqueue(sseChunk({}, finishReason, state.usage))
		controller.enqueue(encoder.encode(SSE_DONE))
		state.finished = true
		options.onTerminalState?.(
			diagnostics({
				terminal_provenance: state.terminalProvenance || "clean_eventstream_eof",
				transport_state: state.transportState,
				// Report what this exit actually did, not the raw disposition. The
				// integrity gate re-derives its verdict from stop_disposition, so
				// reporting "terminal_incomplete" for a turn we deliberately kept made
				// it discard the very bytes we just released to the client.
				stop_disposition: truncatedAfterOutput ? "length" : disposition,
			}),
		)
	}

	if (!response.body) {
		const detail = diagnostics({
			terminal_provenance: "missing_response_body",
			transport_state: "missing_body",
			stop_disposition: "terminal_incomplete",
		})
		options.onTerminalState?.(detail)
		return new Response(
			encodeSSEError(
				"kiro_missing_terminal",
				"Kiro response did not include an EventStream body",
				detail,
			),
			{ status: response.status, headers: { ...SSE_HEADERS } },
		)
	}

	const reader = response.body.getReader()
	const stream = new ReadableStream({
		start: async (controller) => {
			try {
				while (!state.finished) {
					const { done, value } = await reader.read()
					if (done) break
					const chunksBefore = state.chunkIndex
					const framesBefore = state.validatedFrames
					if (!processBytes(value, controller)) {
						await reader.cancel("invalid Kiro EventStream").catch(() => {})
						break
					}
					if (state.validatedFrames > framesBefore && state.chunkIndex === chunksBefore) {
						controller.enqueue(encoder.encode(": kiro-upstream\n\n"))
					}
				}
				finish(controller)
				controller.close()
			} catch (error) {
				if (!state.finished) {
					fail(
						controller,
						"upstream_read_error",
						"kiro_missing_terminal",
						error.message || "Kiro EventStream read failed",
						{ transport_state: "upstream_error" },
					)
				}
				controller.close()
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: { ...SSE_HEADERS },
	})
}
