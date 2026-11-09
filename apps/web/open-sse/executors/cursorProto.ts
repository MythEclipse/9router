import crypto from "node:crypto"
import zlib from "node:zlib"
import { OPENAI_BLOCK, ROLE } from "../translator/schema/index.ts"
import { encodeField, encodeMcpTools, wrapConnectRPCFrame } from "../utils/cursorProtobuf.ts"

export const AGENT_RUN_PATH = "/agent.v1.AgentService/Run"

import { COMPRESS_FLAG } from "./cursorFrame.ts"

export { COMPRESS_FLAG } from "./cursorFrame.ts"

const PROTOBUF_LEN = 2
const PROTOBUF_VARINT = 0

export function concatBuffers(...parts) {
	const length = parts.reduce((total, part) => total + part.length, 0)
	const result = new Uint8Array(length)
	let offset = 0
	for (const part of parts) {
		result.set(part, offset)
		offset += part.length
	}
	return result
}

export const agentString = (field, value) => encodeField(field, PROTOBUF_LEN, value)
export const agentMessage = (field, value) => encodeField(field, PROTOBUF_LEN, value)
export const agentBool = (field, value) => encodeField(field, PROTOBUF_VARINT, value ? 1 : 0)

function textFromContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((part) => part?.type === OPENAI_BLOCK.TEXT && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
}

function isTextPart(part) {
	return !part || part.type === OPENAI_BLOCK.TEXT || typeof part === "string"
}

export function isAgentCapableRequest(body) {
	// ChatService rejects auto/composer and most thinking variants. AgentService
	// can answer text turns (including declared tool schemas) and tool-call
	// history. Image parts still need the legacy protobuf path.
	if (!Array.isArray(body?.messages) || body.messages.length === 0) return false
	return body.messages.every((message) => {
		if (Array.isArray(message?.content)) return message.content.every(isTextPart)
		return message?.content == null || typeof message.content === "string"
	})
}

function encodeHistoryMessage(message) {
	const content = textFromContent(message?.content)
	const extras = []
	if (message?.role === ROLE.ASSISTANT && message.tool_calls?.length) {
		for (const tc of message.tool_calls) {
			extras.push(
				`[tool_call id=${tc.id || ""} name=${tc.function?.name || "tool"} args=${tc.function?.arguments || "{}"}]`,
			)
		}
	}
	if (message?.role === ROLE.TOOL) {
		extras.push(`[tool_result id=${message.tool_call_id || ""}]`)
	}
	const textBody = [content, ...extras].filter(Boolean).join("\n")
	if (!textBody) return null

	// ConversationHistoryMessage.user / .assistant -> repeated content -> text.
	const text = agentString(1, textBody)
	if (message.role === ROLE.ASSISTANT) {
		return agentMessage(2, agentMessage(1, agentMessage(1, text)))
	}
	return agentMessage(1, agentMessage(1, agentMessage(1, text)))
}

export function buildAgentRunFrame(messages, model, tools = [], reasoningEffort = null) {
	// custom_system_prompt (RunRequest field 8) makes AgentService return an
	// empty turn. Fold system text into the current user message instead.
	const system = messages
		.filter((message) => message?.role === ROLE.SYSTEM)
		.map((message) => textFromContent(message.content))
		.filter(Boolean)
		.join("\n\n")
	const chatMessages = messages.filter((message) => message?.role !== ROLE.SYSTEM)
	const currentIndex = [...chatMessages].map((message) => message?.role).lastIndexOf(ROLE.USER)
	const current = currentIndex >= 0 ? chatMessages[currentIndex] : chatMessages.at(-1)
	const history = chatMessages
		.slice(0, currentIndex >= 0 ? currentIndex : -1)
		.map(encodeHistoryMessage)
		.filter(Boolean)
	const rawUser = textFromContent(current?.content) || "Continue."
	const userText = system ? `${system}\n\n${rawUser}` : rawUser

	// agent.v1.UserMessageAction.user_message and its optional history.
	// selected_context (3) + mode=1 (4) match cursor-agent's wire format; without
	// them the server may accept the RPC and stream an empty turn.
	const userMessage = concatBuffers(
		agentString(1, userText),
		agentString(2, crypto.randomUUID()),
		agentMessage(3, new Uint8Array()),
		encodeField(4, PROTOBUF_VARINT, 1),
	)
	const conversationHistory = history.length
		? concatBuffers(...history.map((entry) => agentMessage(1, entry)))
		: null
	const userAction = concatBuffers(
		agentMessage(1, userMessage),
		...(conversationHistory ? [agentMessage(7, conversationHistory)] : []),
	)
	const conversationAction = agentMessage(1, userAction)
	const effort = String(reasoningEffort || "").toLowerCase()
	const effortValue = effort === "ultra" ? "max" : effort === "minimal" ? "low" : effort
	const parameter =
		effortValue && effortValue !== "none"
			? agentMessage(
					3,
					concatBuffers(
						agentString(1, /gpt-/i.test(model) ? "reasoning" : "effort"),
						agentString(2, effortValue),
					),
				)
			: null
	const requestedModel = concatBuffers(
		agentString(1, model),
		agentBool(7, true),
		...(parameter ? [parameter] : []),
	)
	// ModelDetails (field 3): thinking variants (Composer, Grok, *-thinking)
	// return an empty turn when only RequestedModel (field 9) is set.
	const modelDetails = concatBuffers(
		agentString(1, model),
		agentString(3, model),
		agentString(4, model),
	)
	const mcpTools = encodeMcpTools(tools)
	const runRequest = concatBuffers(
		// An empty ConversationStateStructure starts a fresh local agent session.
		agentMessage(1, new Uint8Array()),
		agentMessage(2, conversationAction),
		agentMessage(3, modelDetails),
		...(mcpTools.length ? [agentMessage(4, mcpTools)] : []),
		agentMessage(9, requestedModel),
	)

	// agent.v1.AgentClientMessage.run_request.
	return wrapConnectRPCFrame(agentMessage(1, runRequest))
}

export function extractAgentString(message, field) {
	const value = message?.get(field)?.[0]?.value
	return value ? Buffer.from(value).toString("utf8") : ""
}

export function decodeAgentFrames(buffer, onFrame) {
	let pending = Buffer.from(buffer || [])
	while (pending.length >= 5) {
		const flags = pending[0]
		const length = pending.readUInt32BE(1)
		if (pending.length < 5 + length) break
		let payload = pending.subarray(5, 5 + length)
		pending = pending.subarray(5 + length)
		if (flags & COMPRESS_FLAG.GZIP) {
			payload = zlib.gunzipSync(payload)
		}
		if (!(flags & COMPRESS_FLAG.TRAILER)) onFrame(payload)
	}
	return pending
}

function execIds(execRequest) {
	const id = Number(execRequest?.get(1)?.[0]?.value || 0)
	const execId = extractAgentString(execRequest, 15)
	return { id, execId }
}

function wrapExecClientMessage(execMsgId, execId, resultField, resultPayload) {
	const parts = []
	if (execMsgId) parts.push(encodeField(1, PROTOBUF_VARINT, execMsgId))
	parts.push(agentString(15, execId || ""))
	parts.push(encodeField(resultField, PROTOBUF_LEN, resultPayload || new Uint8Array()))
	return wrapConnectRPCFrame(agentMessage(2, concatBuffers(...parts)))
}

export function createRequestContextResponse(execRequest) {
	// Tools already go out on AgentRunRequest.mcp_tools. Echoing them again on
	// this ack makes AgentService stall silently (0 SSE bytes until abort).
	const { id, execId } = execIds(execRequest)
	const requestContextSuccess = agentMessage(1, new Uint8Array())
	const requestContextResult = agentMessage(1, requestContextSuccess)
	return wrapExecClientMessage(id, execId, 10, requestContextResult)
}

// ExecServerMessage variant → ExecClientMessage result field (same numbers).
const EXEC_RESULT_FIELD = {
	2: 2,
	3: 3,
	4: 4,
	5: 5,
	7: 7,
	8: 8,
	9: 9,
	16: 16,
	20: 20,
	23: 23,
}

export function rejectExecRequest(execRequest) {
	const { id, execId } = execIds(execRequest)
	const variant = [...(execRequest?.keys?.() || [])].find((field) => field !== 1 && field !== 15)
	const resultField = EXEC_RESULT_FIELD[variant]
	if (!resultField) return null
	// Diagnostics has no rejected variant - empty success unblocks the stream.
	if (variant === 9) return wrapExecClientMessage(id, execId, 9, new Uint8Array())
	const rejected = agentMessage(
		2,
		agentString(2, "Tool not available in this environment. Use the MCP tools provided instead."),
	)
	return wrapExecClientMessage(id, execId, resultField, rejected)
}

export function encodeKvClientMessage(kvId, resultField, resultPayload, metadata) {
	const parts = []
	if (kvId) parts.push(encodeField(1, PROTOBUF_VARINT, kvId))
	parts.push(encodeField(resultField, PROTOBUF_LEN, resultPayload || new Uint8Array()))
	if (metadata && metadata.length) parts.push(encodeField(4, PROTOBUF_LEN, metadata))
	return wrapConnectRPCFrame(agentMessage(3, concatBuffers(...parts)))
}

export { decompressPayload, readCursorFrame } from "./cursorFrame.ts"
