import { concatArrays, encodeField, WIRE_TYPE } from "./cursorProtobuf.ts"
import { decodeMessage } from "./cursorProtobufDecode.ts"

const PB_VALUE = { NULL: 1, NUMBER: 2, STRING: 3, BOOL: 4, STRUCT: 5, LIST: 6 }
const PB_STRUCT_FIELDS = 1
const PB_MAP_KEY = 1
const PB_MAP_VALUE = 2
const PB_LIST_VALUES = 1

const MTD_NAME = 1
const MTD_DESCRIPTION = 2
const MTD_INPUT_SCHEMA = 3
const MTD_PROVIDER = 4
const MTD_TOOL_NAME = 5

const MCP_TOOLS_TOOL = 1

const MCP_ARGS_NAME = 1
const MCP_ARGS_ENTRY = 2
const MCP_ARGS_CALL_ID = 3
const MCP_ARGS_TOOL_NAME = 5

const MCR_SUCCESS = 1
const MCR_ERROR = 2
const MCR_TOOL_NOT_FOUND = 5
const MCS_CONTENT = 1
const MCS_IS_ERROR = 2
const MCC_TEXT = 1
const MCC_IMAGE = 2
const MTC_TEXT = 1
const MIC_DATA = 1
const MIC_MIME = 2
const MER_MESSAGE = 1
const TNF_NAME = 1

function asBytes(value) {
	if (!value) return Buffer.alloc(0)
	return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

/**
 * Encode a JS value as google.protobuf.Value (oneof body, no outer tag).
 */
export function encodeAgentValue(value) {
	if (value === null || value === undefined) {
		return encodeField(PB_VALUE.NULL, WIRE_TYPE.VARINT, 0)
	}
	if (typeof value === "boolean") {
		return encodeField(PB_VALUE.BOOL, WIRE_TYPE.VARINT, value ? 1 : 0)
	}
	if (typeof value === "number") {
		return encodeField(PB_VALUE.NUMBER, WIRE_TYPE.FIXED64, value)
	}
	if (typeof value === "string") {
		return encodeField(PB_VALUE.STRING, WIRE_TYPE.LEN, value)
	}
	if (Array.isArray(value)) {
		const items = value.map((item) =>
			encodeField(PB_LIST_VALUES, WIRE_TYPE.LEN, encodeAgentValue(item)),
		)
		return encodeField(PB_VALUE.LIST, WIRE_TYPE.LEN, concatArrays(...items))
	}
	if (typeof value === "object") {
		const entries = Object.entries(value).map(([key, val]) =>
			encodeField(
				PB_STRUCT_FIELDS,
				WIRE_TYPE.LEN,
				concatArrays(
					encodeField(PB_MAP_KEY, WIRE_TYPE.LEN, key),
					encodeField(PB_MAP_VALUE, WIRE_TYPE.LEN, encodeAgentValue(val)),
				),
			),
		)
		return encodeField(PB_VALUE.STRUCT, WIRE_TYPE.LEN, concatArrays(...entries))
	}
	return encodeField(PB_VALUE.STRING, WIRE_TYPE.LEN, String(value))
}

/**
 * Decode google.protobuf.Value bytes back to a JS value.
 */
export function decodeAgentValue(bytes) {
	const fields = decodeMessage(asBytes(bytes))
	if (fields.has(PB_VALUE.NULL)) return null
	if (fields.has(PB_VALUE.BOOL)) return fields.get(PB_VALUE.BOOL)[0].value !== 0
	if (fields.has(PB_VALUE.NUMBER)) {
		return asBytes(fields.get(PB_VALUE.NUMBER)[0].value).readDoubleLE(0)
	}
	if (fields.has(PB_VALUE.STRING)) {
		return asBytes(fields.get(PB_VALUE.STRING)[0].value).toString("utf8")
	}
	if (fields.has(PB_VALUE.STRUCT)) {
		const result = {}
		for (const entry of decodeMessage(asBytes(fields.get(PB_VALUE.STRUCT)[0].value)).get(
			PB_STRUCT_FIELDS,
		) || []) {
			const pair = decodeMessage(asBytes(entry.value))
			const key = asBytes(pair.get(PB_MAP_KEY)?.[0]?.value).toString("utf8")
			if (key) result[key] = decodeAgentValue(pair.get(PB_MAP_VALUE)?.[0]?.value)
		}
		return result
	}
	if (fields.has(PB_VALUE.LIST)) {
		return (decodeMessage(asBytes(fields.get(PB_VALUE.LIST)[0].value)).get(PB_LIST_VALUES) || []).map(
			(item) => decodeAgentValue(item.value),
		)
	}
	return null
}

function toolNameAndSchema(tool) {
	const fn = tool?.function || tool || {}
	return {
		name: fn.name || tool?.name || "",
		description: fn.description || tool?.description || "",
		schema: fn.parameters || tool?.parameters || tool?.inputSchema || tool?.input_schema || {},
	}
}

/**
 * Encode agent.v1.McpToolDefinition body (name, description, Value schema, provider, tool_name).
 */
export function encodeMcpToolDefinition(tool) {
	const { name, description, schema } = toolNameAndSchema(tool)
	return concatArrays(
		encodeField(MTD_NAME, WIRE_TYPE.LEN, name),
		encodeField(MTD_DESCRIPTION, WIRE_TYPE.LEN, description),
		encodeField(MTD_INPUT_SCHEMA, WIRE_TYPE.LEN, encodeAgentValue(schema)),
		encodeField(MTD_PROVIDER, WIRE_TYPE.LEN, "9router"),
		encodeField(MTD_TOOL_NAME, WIRE_TYPE.LEN, name),
	)
}

/**
 * Encode AgentRunRequest.mcp_tools: repeated McpToolDefinition under field 1.
 */
export function encodeMcpTools(tools = []) {
	if (!tools?.length) return new Uint8Array()
	return concatArrays(
		...tools.map((tool) => encodeField(MCP_TOOLS_TOOL, WIRE_TYPE.LEN, encodeMcpToolDefinition(tool))),
	)
}

/**
 * Decode agent.v1.McpArgs (name, typed args map, toolCallId, toolName).
 */
export function decodeMcpArgs(bytes) {
	const msg = decodeMessage(asBytes(bytes))
	const args = {}
	for (const entry of msg.get(MCP_ARGS_ENTRY) || []) {
		const pair = decodeMessage(asBytes(entry.value))
		const key = asBytes(pair.get(PB_MAP_KEY)?.[0]?.value).toString("utf8")
		if (key) args[key] = decodeAgentValue(pair.get(PB_MAP_VALUE)?.[0]?.value)
	}
	const read = (field) => asBytes(msg.get(field)?.[0]?.value).toString("utf8")
	return {
		name: read(MCP_ARGS_NAME),
		toolCallId: read(MCP_ARGS_CALL_ID),
		toolName: read(MCP_ARGS_TOOL_NAME),
		args,
	}
}

function encodeMcpTextItem(text) {
	return encodeField(
		MCS_CONTENT,
		WIRE_TYPE.LEN,
		encodeField(MCC_TEXT, WIRE_TYPE.LEN, encodeField(MTC_TEXT, WIRE_TYPE.LEN, text)),
	)
}

function encodeMcpImageItem(image) {
	const data = image?.data || image || new Uint8Array()
	const mimeType = image?.mimeType || "application/octet-stream"
	return encodeField(
		MCS_CONTENT,
		WIRE_TYPE.LEN,
		encodeField(
			MCC_IMAGE,
			WIRE_TYPE.LEN,
			concatArrays(
				encodeField(MIC_DATA, WIRE_TYPE.LEN, data),
				encodeField(MIC_MIME, WIRE_TYPE.LEN, mimeType),
			),
		),
	)
}

export function encodeMcpResultSuccess({ textItems = [], imageItems = [], isError = false } = {}) {
	const success = concatArrays(
		...textItems.map(encodeMcpTextItem),
		...imageItems.map(encodeMcpImageItem),
		encodeField(MCS_IS_ERROR, WIRE_TYPE.VARINT, isError ? 1 : 0),
	)
	return encodeField(MCR_SUCCESS, WIRE_TYPE.LEN, success)
}

export function encodeMcpResultError(message) {
	return encodeField(
		MCR_ERROR,
		WIRE_TYPE.LEN,
		encodeField(MER_MESSAGE, WIRE_TYPE.LEN, String(message || "")),
	)
}

export function encodeMcpResultToolNotFound(name) {
	return encodeField(
		MCR_TOOL_NOT_FOUND,
		WIRE_TYPE.LEN,
		encodeField(TNF_NAME, WIRE_TYPE.LEN, String(name || "")),
	)
}
