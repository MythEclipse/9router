import { PROVIDERS } from "../../config/providers.ts"
import { HTTP_STATUS } from "../../config/runtimeConfig.ts"
import { collectJsonFrames } from "../../transformer/jsonToStreamConverter.ts"
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.ts"
import { openAICompletionToClaudeMessage } from "../../translator/concerns/claudeMessage.ts"
import { toOpenAIFinish } from "../../translator/concerns/finishReason.ts"
import { extractReasoningText } from "../../translator/concerns/reasoning.ts"
import { FORMATS } from "../../translator/formats.ts"
import { initState, translateResponse } from "../../translator/index.ts"
import {
	CLAUDE_BLOCK,
	CLAUDE_EVENT,
	MODEL_FALLBACK,
	OPENAI_BLOCK,
	OPENAI_FINISH,
	RESPONSES_EVENT,
	RESPONSES_ITEM,
	ROLE,
} from "../../translator/schema/index.ts"
import { createErrorResult } from "../../utils/error.ts"
import { applyModelAlias, calledModelName } from "../../utils/modelAlias.ts"
import { restoreToolNames } from "../../utils/opencodeFingerprint.ts"
import { applyUsageMultipliers } from "../../utils/usageTracking.ts"
import { attachWebSearchToClaudeBody } from "../webSearchBody.ts"
import {
	buildRequestDetail,
	extractRequestConfig,
	formatDoneLine,
	saveUsageStats,
} from "./requestDetail.ts"

// Frames whose `type` is a provider event name, mapped to the translator format
// that can decode that event stream into OpenAI chunks.
const EVENT_FRAME_FORMAT = {
	[CLAUDE_EVENT.MESSAGE_START]: FORMATS.CLAUDE,
	[CLAUDE_EVENT.CONTENT_BLOCK_START]: FORMATS.CLAUDE,
	[CLAUDE_EVENT.CONTENT_BLOCK_DELTA]: FORMATS.CLAUDE,
	[CLAUDE_EVENT.CONTENT_BLOCK_STOP]: FORMATS.CLAUDE,
	[CLAUDE_EVENT.MESSAGE_DELTA]: FORMATS.CLAUDE,
	[CLAUDE_EVENT.MESSAGE_STOP]: FORMATS.CLAUDE,
	[CLAUDE_EVENT.ERROR]: FORMATS.CLAUDE,
	[RESPONSES_EVENT.CREATED]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.OUTPUT_ITEM_ADDED]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.OUTPUT_TEXT_DELTA]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.REASONING_SUMMARY_TEXT_DELTA]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DELTA]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.OUTPUT_ITEM_DONE]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.COMPLETED]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.FAILED]: FORMATS.OPENAI_RESPONSES,
	[RESPONSES_EVENT.DONE]: FORMATS.OPENAI_RESPONSES,
}

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES

function isAbortError(error) {
	return error?.name === "AbortError" || error?.code === "ABORT_ERR"
}

import { saveRequestDetail } from "@/lib/usageDb"
import { chatCompletionToResponses } from "./sseJsonParseA.ts"

export function hasAnswer(body) {
	const message = body?.choices?.[0]?.message
	if (!message) return false
	return !!(
		message.content ||
		message.tool_calls?.length ||
		message.reasoning_content ||
		body?.usage
	)
}

/**
 * Replay provider event frames (Claude Messages / OpenAI Responses) through the
 * same response translators the live streaming path uses, so this fallback can
 * never drift from what a normal stream would have produced.
 */
export function translateFramesToChunks(frames, eventFormat, fallbackModel) {
	const state = { ...initState(FORMATS.OPENAI), model: fallbackModel, customToolNames: new Set() }
	const chunks: Record<string, unknown>[] = []
	for (const frame of frames) {
		try {
			for (const translated of ([] as unknown[]).concat(
				translateResponse(eventFormat, FORMATS.OPENAI, frame, state) || [],
			)) {
				if (translated && typeof translated === "object")
					chunks.push(translated as Record<string, unknown>)
			}
		} catch {
			/* a frame this translator cannot read is picked up by the harvest fallback */
		}
	}
	return chunks
}

/**
 * Last resort: walk the frames and collect whatever assistant text, reasoning,
 * tool calls and usage they carry, wherever they put it. Deliberately dumb - it
 * exists so an unfamiliar provider shape surfaces as a rough answer instead of a
 * blank one.
 */
export function harvestCompletion(frames, fallbackModel) {
	let text = ""
	let reasoning = ""
	let usage: unknown = null
	let model = fallbackModel || MODEL_FALLBACK
	let finishReason: string | null = null
	const toolCalls = new Map<string, Record<string, unknown>>()

	const pushToolCall = (key, call) => {
		if (!call?.name && !call?.id) return
		toolCalls.set(String(key), call)
	}

	for (const frame of frames) {
		if (!frame || typeof frame !== "object") continue
		if (frame.model || frame.message?.model) model = frame.model || frame.message.model
		usage =
			frame.usage || frame.message?.usage || frame.response?.usage || frame.usageMetadata || usage
		if (frame.delta?.stop_reason)
			finishReason = toOpenAIFinish(frame.delta.stop_reason, FORMATS.CLAUDE)
		if (frame.candidates?.[0]?.finishReason)
			finishReason = toOpenAIFinish(frame.candidates[0].finishReason, FORMATS.GEMINI)

		for (const block of [].concat(frame.content || [])) {
			if (!block || typeof block !== "object") continue
			if (block.type === CLAUDE_BLOCK.TEXT) text += block.text || ""
			else if (block.type === CLAUDE_BLOCK.THINKING) reasoning += block.thinking || ""
			else if (block.type === CLAUDE_BLOCK.TOOL_USE)
				pushToolCall(`blk${block.id || toolCalls.size}`, {
					id: block.id,
					name: block.name,
					input: block.input,
				})
		}
		for (const part of [].concat(frame.candidates?.[0]?.content?.parts || [])) {
			if (!part || typeof part !== "object") continue
			if (typeof part.text === "string") {
				if (part.thought === true) reasoning += part.text
				else text += part.text
			}
			if (part.functionCall?.name)
				pushToolCall(`fn${part.functionCall.name}${toolCalls.size}`, {
					name: part.functionCall.name,
					input: part.functionCall.args,
				})
		}
		for (const item of [].concat(frame.output || frame.response?.output || [])) {
			if (!item || typeof item !== "object") continue
			if (item.type === RESPONSES_ITEM.OUTPUT_TEXT) text += item.text || ""
			else if (item.type === RESPONSES_ITEM.MESSAGE) {
				for (const c of [].concat(item.content || [])) if (typeof c?.text === "string") text += c.text
			} else if (item.type === RESPONSES_ITEM.FUNCTION_CALL) {
				pushToolCall(`rc${item.call_id || item.id || toolCalls.size}`, {
					name: item.name,
					input: item.arguments,
				})
			} else if (item.type === RESPONSES_ITEM.REASONING) {
				for (const s of [].concat(item.summary || []))
					if (typeof s?.text === "string") reasoning += s.text
			}
		}

		const delta = frame.delta
		if (typeof delta === "string") text += delta
		else if (delta && typeof delta === "object") {
			if (typeof delta.text === "string") text += delta.text
			if (typeof delta.content === "string" && !Array.isArray(frame.choices)) text += delta.content
			if (typeof delta.thinking === "string") reasoning += delta.thinking
			if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
			if (typeof delta.partial_json === "string" && toolCalls.size) {
				const last = [...toolCalls.values()].pop()
				last.input = `${typeof last.input === "string" ? last.input : ""}${delta.partial_json}`
			}
			for (const tc of [].concat(delta.tool_calls || [])) {
				if (!tc?.function?.name && !tc?.function?.arguments) continue
				const key = `d${tc.index ?? toolCalls.size}`
				const prev = toolCalls.get(key) || { id: tc.id, name: "", input: "" }
				toolCalls.set(key, {
					id: tc.id || prev.id,
					name: `${prev.name || ""}${tc.function?.name || ""}`,
					input: `${typeof prev.input === "string" ? prev.input : ""}${tc.function?.arguments || ""}`,
				})
			}
		}
	}

	if (!text && !reasoning && toolCalls.size === 0) return null

	const message: Record<string, unknown> = {
		role: ROLE.ASSISTANT,
		content: text || (toolCalls.size ? null : ""),
	}
	if (reasoning) message.reasoning_content = reasoning
	if (toolCalls.size) {
		message.tool_calls = [...toolCalls.entries()].map(([key, call], index) => ({
			id: call.id || `call_${index}`,
			type: OPENAI_BLOCK.FUNCTION,
			function: {
				name: call.name || key,
				arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input || {}),
			},
		}))
	}
	const body: Record<string, unknown> = {
		id: `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message,
				finish_reason: finishReason || (toolCalls.size ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP),
			},
		],
	}
	if (usage) body.usage = usage
	return body
}

/** Accumulate OpenAI chat.completion.chunk frames into one completion. */
export function accumulateOpenAIChunks(chunks, fallbackModel) {
	const first = chunks[0]
	const contentParts: string[] = []
	const reasoningParts: string[] = []
	const toolCallMap = new Map<
		number,
		{ id: string; type: string; function: { name: string; arguments: string } }
	>() // index -> { id, type, function: { name, arguments } }
	let usage: unknown = null
	let finishReason: string | null = null

	for (const chunk of chunks) {
		const choice = chunk?.choices?.[0]
		const delta = choice?.delta || {}
		if (typeof delta.content === "string" && delta.content.length > 0)
			contentParts.push(delta.content)
		// Vendor aliases (`reasoning`, `reasoning_details[]`) count as reasoning too:
		// without this an alias lane's thinking is silently dropped before the
		// empty-content rescue below could keep it.
		const reasoningText = extractReasoningText(delta)
		if (reasoningText.length > 0) reasoningParts.push(reasoningText)
		if (choice?.finish_reason) finishReason = choice.finish_reason
		if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage

		// Accumulate tool_calls from streaming deltas
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const idx = tc.index ?? 0
				if (!toolCallMap.has(idx)) {
					toolCallMap.set(idx, {
						id: tc.id || "",
						type: "function",
						function: { name: "", arguments: "" },
					})
				}
				const existing = toolCallMap.get(idx)
				if (tc.id) existing.id = tc.id
				if (tc.function?.name) existing.function.name += tc.function.name
				if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
			}
		}
	}

	const message: Record<string, unknown> = {
		role: "assistant",
		content: contentParts.join("") || (toolCallMap.size > 0 ? null : ""),
	}
	if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("")
	if (toolCallMap.size > 0) {
		message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc)
	}

	const result: Record<string, unknown> = {
		id: first.id || `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: first.created || Math.floor(Date.now() / 1000),
		model: first.model || fallbackModel || "unknown",
		choices: [
			{
				index: 0,
				message,
				finish_reason:
					finishReason ||
					(usage && chunks.every((chunk) => Array.isArray(chunk?.choices) && chunk.choices.length === 0)
						? OPENAI_FINISH.STOP
						: null),
			},
		],
	}
	if (usage) result.usage = usage
	return result
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
/**
 * The subset of the chat-core request context this handler reads. `sharedCtx`
 * carries a few extra keys (plugin result, pxpipe summary) that this path does
 * not consume; declaring the used subset keeps the spread call site checked
 * without demanding keys the caller has no reason to compute.
 */
