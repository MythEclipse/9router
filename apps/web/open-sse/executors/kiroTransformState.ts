import { resolveKiroModel } from "../config/kiroConstants.ts"
import type { KiroStreamTransformOptions } from "./kiroStream.ts"
import {
	encoder,
	encodeSSEError,
	KIRO_REPAIR_BUFFER_MAX_BYTES,
	stopDisposition,
} from "./kiroStream.ts"

export function createKiroTransformContext(
	model: string,
	options: KiroStreamTransformOptions = {},
) {
	const responseId = `chatcmpl-${Date.now()}`
	const created = Math.floor(Date.now() / 1000)
	const _capabilityModel = resolveKiroModel(model).upstream
	const eventCounts = {}
	const state = {
		buffer: new Uint8Array(0),
		chunkIndex: 0,
		toolCounter: 0,
		tools: new Map(),
		bufferedToolBytes: 0,
		hasText: false,
		hasReasoning: false,
		hasCode: false,
		hasToolCalls: false,
		sawToolUse: false,
		explicitStop: false,
		stopReason: null,
		terminalProvenance: null,
		transportState: "consuming_response",
		totalContentLength: 0,
		contextUsagePercentage: 0,
		hasContextUsage: false,
		hasMetering: false,
		hasNativeUsage: false,
		usage: null,
		inThinking: false,
		toolValidationError: null,
		validatedFrames: 0,
		droppedTools: 0,
		finished: false,
	}

	const diagnostics = (overrides: Record<string, unknown> = {}) => ({
		terminal_provenance: state.terminalProvenance || "clean_eventstream_eof",
		transport_state: state.transportState,
		stop_reason: state.stopReason,
		stop_disposition: stopDisposition(state.stopReason, state.hasToolCalls),
		response_state: state.hasToolCalls
			? "valid_tool"
			: state.hasText || state.hasReasoning || state.hasCode
				? "text_reasoning"
				: state.explicitStop
					? "explicit_stop"
					: "no_semantic_output",
		event_counts: { ...eventCounts },
		incomplete_frame_bytes: state.buffer.byteLength,
		...overrides,
	})
	const sseChunk = (
		delta: Record<string, unknown>,
		finishReason: string | null = null,
		usage?: unknown,
	) =>
		encoder.encode(
			`data: ${JSON.stringify({
				id: responseId,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta, finish_reason: finishReason }],
				...(usage ? { usage } : {}),
			})}\n\n`,
		)
	const emitDelta = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		delta: Record<string, unknown>,
	) => {
		if (state.chunkIndex === 0) delta = { role: "assistant", ...delta }
		state.chunkIndex++
		controller.enqueue(sseChunk(delta))
	}
	const fail = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		provenance: string,
		code: string,
		message: string,
		extra: Record<string, unknown> = {},
	) => {
		state.finished = true
		state.terminalProvenance = provenance
		state.transportState = (extra.transport_state as string) || "corrupt_frame"
		const detail = diagnostics({
			stop_disposition: extra.stop_disposition || "terminal_incomplete",
			...extra,
		})
		options.onTerminalState?.(detail)
		controller.enqueue(encodeSSEError(code, message, detail))
	}
	const assertToolBufferBound = () => {
		if (state.bufferedToolBytes <= (options.maxToolBytes || KIRO_REPAIR_BUFFER_MAX_BYTES / 2)) return
		const error = Object.assign(
			new Error("Kiro buffered tool input exceeded the integrity memory bound"),
			{ code: "KIRO_BUFFER_EXCEEDED" },
		)
		throw error
	}
	const appendToolInput = (tool, input) => {
		if (input === undefined) return
		if (typeof input === "string") {
			if (tool.inputKind && tool.inputKind !== "string")
				throw new Error("Kiro tool input changed fragment type")
			tool.inputKind = "string"
			tool.inputChunks ||= []
			tool.inputChunks.push(input)
			state.bufferedToolBytes += encoder.encode(input).byteLength
		} else if (input && typeof input === "object" && !Array.isArray(input)) {
			if (tool.inputKind && tool.inputKind !== "object")
				throw new Error("Kiro tool input changed fragment type")
			tool.inputKind = "object"
			state.bufferedToolBytes -= tool.inputBytes || 0
			tool.inputObject = input
			tool.inputBytes = encoder.encode(JSON.stringify(input)).byteLength
			state.bufferedToolBytes += tool.inputBytes
		} else {
			throw new Error("Kiro tool input must be a JSON object")
		}
		assertToolBufferBound()
	}
	const parsedToolInput = (tool) => {
		if (!tool.inputKind) throw new Error("Kiro tool call is missing input")
		if (tool.inputKind === "object") return tool.inputObject
		try {
			const input = JSON.parse(tool.inputChunks.join(""))
			if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object")
			return input
		} catch (error) {
			throw new Error(`Kiro tool input must be valid object JSON (${error.message})`)
		}
	}
	const emitTools = (controller) => {
		for (const tool of state.tools.values()) {
			// Validate per tool, not per turn: one unusable fragment used to throw out
			// of emitTools and take every other complete tool call in the same turn
			// with it, which the client saw as a turn that answered nothing.
			let input
			try {
				input = parsedToolInput(tool)
				if (tool.name === "tool_call") {
					if (typeof input.name !== "string" || !input.name.trim()) {
						throw new Error("Invalid Kiro tool_call payload: missing nested MCP tool name")
					}
					if (!Object.hasOwn(input, "arguments")) {
						throw new Error("Invalid Kiro tool_call payload: missing nested MCP tool arguments")
					}
				}
			} catch (error) {
				state.droppedTools = (state.droppedTools || 0) + 1
				state.toolValidationError ||= error.message
				console.error(`[Kiro] dropping unusable tool call ${tool.id} (${tool.name}): ${error.message}`)
				continue
			}
			const index = state.toolCounter++
			emitDelta(controller, {
				tool_calls: [
					{
						index,
						id: tool.id,
						type: "function",
						function: { name: tool.name, arguments: "" },
					},
				],
			})
			const serializedInput = JSON.stringify(input)
			emitDelta(controller, {
				tool_calls: [{ index, function: { arguments: serializedInput } }],
			})
			// Tool arguments are billed output like any other completion bytes. They
			// were never added to totalContentLength, so the /4 estimator in finish()
			// reported OUT 0 -- or the Math.max floor of 1 -- for every turn whose
			// entire answer was a tool call.
			state.totalContentLength += tool.name.length + serializedInput.length
			state.hasToolCalls = true
		}
		state.tools.clear()
		state.bufferedToolBytes = 0
		// A declared tool turn that emitted no usable call is only fatal when the
		// turn produced nothing else. Throwing unconditionally here escaped
		// emitTools() with provenance "invalid_tool_call", which the integrity gate
		// re-derived into a repair retry -- discarding text the client had already
		// been promised.
		if (
			state.stopReason === "tool_use" &&
			!state.hasToolCalls &&
			!state.hasText &&
			!state.hasReasoning &&
			!state.hasCode
		) {
			throw new Error("Kiro tool_use stop reason did not include a complete tool call")
		}
	}
	return {
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
	}
}
export type KiroTransformContext = ReturnType<typeof createKiroTransformContext>
