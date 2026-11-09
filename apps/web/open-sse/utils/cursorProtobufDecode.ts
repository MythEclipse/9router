const DEBUG = process.env.CURSOR_PROTOBUF_DEBUG === "1"
const log = (tag, ...args) => DEBUG && console.log(`[PROTOBUF:${tag}]`, ...args)

import zlib from "node:zlib"
import {
	FIELD,
	KNOWN_RESPONSE_FIELDS,
	PROTOBUF_SCHEMA_VERSION,
	WIRE_TYPE,
} from "./cursorProtobuf.ts"

export function decodeVarint(buffer, offset) {
	let result = 0
	let shift = 0
	let pos = offset

	while (pos < buffer.length) {
		const b = buffer[pos]
		result |= (b & 0x7f) << shift
		pos++
		if (!(b & 0x80)) break
		shift += 7
	}

	return [result, pos]
}

export function decodeField(buffer, offset) {
	if (offset >= buffer.length) return [null, null, null, offset]

	const [tag, pos1] = decodeVarint(buffer, offset)
	const fieldNum = tag >> 3
	const wireType = tag & 0x07

	let value
	let pos = pos1

	if (wireType === WIRE_TYPE.VARINT) {
		;[value, pos] = decodeVarint(buffer, pos)
	} else if (wireType === WIRE_TYPE.LEN) {
		const [length, pos2] = decodeVarint(buffer, pos)
		value = buffer.slice(pos2, pos2 + length)
		pos = pos2 + length
	} else if (wireType === WIRE_TYPE.FIXED64) {
		value = buffer.slice(pos, pos + 8)
		pos += 8
	} else if (wireType === WIRE_TYPE.FIXED32) {
		value = buffer.slice(pos, pos + 4)
		pos += 4
	} else {
		value = null
	}

	return [fieldNum, wireType, value, pos]
}

export function decodeMessage(data) {
	const fields = new Map()
	let pos = 0

	while (pos < data.length) {
		const [fieldNum, wireType, value, newPos] = decodeField(data, pos)
		if (fieldNum === null) break

		if (!fields.has(fieldNum)) fields.set(fieldNum, [])
		fields.get(fieldNum).push({ wireType, value })
		pos = newPos
	}

	return fields
}

// ==================== RESPONSE PARSING ====================

export function parseConnectRPCFrame(buffer) {
	if (buffer.length < 5) return null

	const flags = buffer[0]
	const length = (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4]

	if (buffer.length < 5 + length) return null

	let payload = buffer.slice(5, 5 + length)

	// Decompress if gzip
	if (flags === 0x01) {
		try {
			payload = new Uint8Array(zlib.gunzipSync(Buffer.from(payload)))
		} catch (err) {
			log("PARSE", `Decompression failed: ${err.message}`)
		}
	}

	return { flags, length, payload, consumed: 5 + length }
}

function extractToolCall(toolCallData) {
	const toolCall = decodeMessage(toolCallData)
	let toolCallId = ""
	let toolName = ""
	let rawArgs = ""
	let isLast = false

	// Extract tool call ID
	if (toolCall.has(FIELD.TOOL_ID)) {
		const fullId = new TextDecoder().decode(toolCall.get(FIELD.TOOL_ID)[0].value)
		toolCallId = fullId.split("\n")[0] // Cursor returns multi-line ID, take first line
	}

	// Extract tool name
	if (toolCall.has(FIELD.TOOL_NAME)) {
		toolName = new TextDecoder().decode(toolCall.get(FIELD.TOOL_NAME)[0].value)
	}

	// Extract is_last flag
	if (toolCall.has(FIELD.TOOL_IS_LAST)) {
		isLast = toolCall.get(FIELD.TOOL_IS_LAST)[0].value !== 0
	}

	// Extract MCP params - nested real tool info
	if (toolCall.has(FIELD.TOOL_MCP_PARAMS)) {
		try {
			const mcpParams = decodeMessage(toolCall.get(FIELD.TOOL_MCP_PARAMS)[0].value)

			if (mcpParams.has(FIELD.MCP_TOOLS_LIST)) {
				const tool = decodeMessage(mcpParams.get(FIELD.MCP_TOOLS_LIST)[0].value)

				if (tool.has(FIELD.MCP_NESTED_NAME)) {
					toolName = new TextDecoder().decode(tool.get(FIELD.MCP_NESTED_NAME)[0].value)
				}

				if (tool.has(FIELD.MCP_NESTED_PARAMS)) {
					rawArgs = new TextDecoder().decode(tool.get(FIELD.MCP_NESTED_PARAMS)[0].value)
				}
			}
		} catch (err) {
			log("EXTRACT", `MCP parse error: ${err.message}`)
		}
	}

	// Fallback to raw_args
	if (!rawArgs && toolCall.has(FIELD.TOOL_RAW_ARGS)) {
		rawArgs = new TextDecoder().decode(toolCall.get(FIELD.TOOL_RAW_ARGS)[0].value)
	}

	if (toolCallId && toolName) {
		return {
			id: toolCallId,
			type: "function",
			function: {
				name: toolName,
				arguments: rawArgs || "{}",
			},
			isLast,
		}
	}

	return null
}

function extractTextAndThinking(responseData) {
	const nested = decodeMessage(responseData)
	let text = null
	let thinking = null

	// Extract text
	if (nested.has(FIELD.RESPONSE_TEXT)) {
		text = new TextDecoder().decode(nested.get(FIELD.RESPONSE_TEXT)[0].value)
	}

	// Extract thinking
	if (nested.has(FIELD.THINKING)) {
		try {
			const thinkingMsg = decodeMessage(nested.get(FIELD.THINKING)[0].value)
			if (thinkingMsg.has(FIELD.THINKING_TEXT)) {
				thinking = new TextDecoder().decode(thinkingMsg.get(FIELD.THINKING_TEXT)[0].value)
			}
		} catch (err) {
			log("EXTRACT", `Thinking parse error: ${err.message}`)
		}
	}

	return { text, thinking }
}

export function extractTextFromResponse(payload) {
	try {
		const fields = decodeMessage(payload)

		// Warn about unknown field numbers - may indicate a Cursor protocol update
		for (const fieldNum of fields.keys()) {
			if (!KNOWN_RESPONSE_FIELDS.has(fieldNum)) {
				log(
					"SCHEMA",
					`Unknown response field #${fieldNum} detected. Schema v${PROTOBUF_SCHEMA_VERSION} may be outdated.`,
				)
			}
		}

		// Field 1: ClientSideToolV2Call
		if (fields.has(FIELD.TOOL_CALL)) {
			const toolCall = extractToolCall(fields.get(FIELD.TOOL_CALL)[0].value)
			if (toolCall) {
				log("EXTRACT", `Tool call: ${toolCall.function.name}`)
				return { text: null, error: null, toolCall, thinking: null }
			}
		}

		// Field 2: StreamUnifiedChatResponse
		if (fields.has(FIELD.RESPONSE)) {
			const { text, thinking } = extractTextAndThinking(fields.get(FIELD.RESPONSE)[0].value)

			if (text || thinking) {
				return { text, error: null, toolCall: null, thinking }
			}
		}

		return { text: null, error: null, toolCall: null, thinking: null }
	} catch (err) {
		log("EXTRACT", `Decode failed (schema v${PROTOBUF_SCHEMA_VERSION}): ${err.message}`)
		return {
			text: null,
			error: null,
			toolCall: null,
			thinking: null,
			raw: Buffer.from(payload).toString("base64"),
			decodeError: err.message,
		}
	}
}

// ==================== AGENT SERVICE (google.protobuf.Value + MCP) ====================
