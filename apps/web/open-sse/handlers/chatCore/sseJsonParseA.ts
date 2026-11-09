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

import {
	accumulateOpenAIChunks,
	harvestCompletion,
	hasAnswer,
	translateFramesToChunks,
} from "./sseJsonParseB.ts"

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
export const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES

export function isAbortError(error) {
	return error?.name === "AbortError" || error?.code === "ABORT_ERR"
}

import { saveRequestDetail } from "@/lib/usageDb"

export function textFromResponsesMessageItem(item) {
	if (!item?.content || !Array.isArray(item.content)) return ""
	const byType = item.content.find((c) => c.type === "output_text")
	if (typeof byType?.text === "string") return byType.text
	const anyText = item.content.find((c) => typeof c.text === "string")
	if (typeof anyText?.text === "string") return anyText.text
	return ""
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
export function pickAssistantMessageForChatCompletion(output) {
	if (!Array.isArray(output)) return { msgItem: null, textContent: null }
	const messages = output.filter((item) => item?.type === "message")
	if (messages.length === 0) return { msgItem: null, textContent: null }
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = textFromResponsesMessageItem(messages[i])
		if (text.length > 0) return { msgItem: messages[i], textContent: text }
	}
	const last = messages[messages.length - 1]
	return { msgItem: last, textContent: textFromResponsesMessageItem(last) }
}

/**
 * Convert an OpenAI Chat Completions JSON body into the Responses API shape.
 * Inlined here (not imported from nonStreamingHandler.js) to avoid a circular
 * import. Mirrors openAICompletionToResponses in nonStreamingHandler.js.
 */
export function extractCustomToolInput(argumentsValue) {
	const argumentsText =
		typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {})
	try {
		const parsed = JSON.parse(argumentsText)
		if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input
	} catch {
		/* raw freeform input */
	}
	return argumentsText
}

export function chatCompletionToResponses(responseBody, customToolNames = null) {
	const choice = responseBody?.choices?.[0]
	if (!choice) return responseBody

	const message = choice.message || {}
	const output: Array<Record<string, unknown>> = []

	const reasoning = message.reasoning_content || message.reasoning
	if (typeof reasoning === "string" && reasoning.length > 0) {
		output.push({
			type: RESPONSES_ITEM.REASONING,
			summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
		})
	}

	const text = typeof message.content === "string" ? message.content : ""
	if (text.length > 0) {
		output.push({
			type: RESPONSES_ITEM.MESSAGE,
			role: ROLE.ASSISTANT,
			content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
		})
	}

	for (const tc of message.tool_calls || []) {
		const fn = tc.function || {}
		const custom = customToolNames?.has(fn.name)
		output.push({
			type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
			id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
			call_id: tc.id || "",
			name: fn.name || "",
			...(custom
				? { input: extractCustomToolInput(fn.arguments) }
				: {
						arguments:
							typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
					}),
		})
	}

	const usage = responseBody.usage || {}
	return {
		id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
		object: "response",
		created_at: responseBody.created || Math.floor(Date.now() / 1000),
		model: responseBody.model || "unknown",
		status: "completed",
		background: false,
		error: null,
		output,
		usage: {
			input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
			output_tokens: usage.completion_tokens || usage.output_tokens || 0,
			total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
		},
	}
}

/**
 * The chat-completion document `parseSSEToOpenAIResponse` hands back: an
 * accumulated completion, or the upstream's own error envelope. Handlers read
 * choices/usage/model off it, so those keys are declared here.
 */
interface ChatCompletionLike {
	error?: { status?: unknown; message?: string; [key: string]: unknown }
	id?: string
	model?: string
	usage?: Record<string, unknown>
	choices?: Array<{
		finish_reason?: string | null
		message?: {
			content?: unknown
			reasoning_content?: unknown
			tool_calls?: unknown[]
			[key: string]: unknown
		}
		[key: string]: unknown
	}>
	[key: string]: unknown
}

/**
 * Parse an SSE-shaped body into a single chat completion. Used when the provider
 * streamed but the client wanted JSON, and whenever an upstream labels a body as
 * `text/event-stream` for a non-streaming request. Real gateways deviate from the
 * spec constantly - no space after `data:`, `event:` field lines, NDJSON rows
 * wearing an SSE content-type, Claude/Responses event frames on an OpenAI route,
 * or a whole JSON document mislabelled as a stream - and every one of those used
 * to read as "no response" and come back as a 502.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel): ChatCompletionLike | null {
	// Frames are arbitrary parsed JSON: every probe below has to tolerate shapes
	// this endpoint has never seen, so the element type stays open.
	const frames = collectJsonFrames(rawSSE) as Record<string, unknown>[]
	if (frames.length === 0) return null

	const openaiChunks: Record<string, unknown>[] = []
	const eventFrames: Record<string, unknown>[] = []
	const unknownFrames: Record<string, unknown>[] = []
	let streamError: unknown = null
	let wholeCompletion: Record<string, unknown> | null = null

	for (const frame of frames) {
		if (!frame || typeof frame !== "object") continue
		if (frame.error) streamError = frame.error
		if (Array.isArray(frame.choices) && frame.choices[0]?.message) wholeCompletion = frame
		else if (Array.isArray(frame.choices)) openaiChunks.push(frame)
		else if (EVENT_FRAME_FORMAT[frame.type as keyof typeof EVENT_FRAME_FORMAT])
			eventFrames.push(frame)
		else unknownFrames.push(frame)
	}

	if (streamError) return { error: streamError as { status?: unknown; message?: string } }
	if (wholeCompletion) return wholeCompletion as ChatCompletionLike

	if (openaiChunks.length) {
		const fromChunks = accumulateOpenAIChunks(openaiChunks, fallbackModel) as ChatCompletionLike
		return hasAnswer(fromChunks) ? fromChunks : harvestCompletion(frames, fallbackModel) || fromChunks
	}
	if (eventFrames.length) {
		const chunks = translateFramesToChunks(
			eventFrames,
			EVENT_FRAME_FORMAT[eventFrames[0].type as keyof typeof EVENT_FRAME_FORMAT],
			fallbackModel,
		)
		const fromEvents = accumulateOpenAIChunks(chunks, fallbackModel) as ChatCompletionLike
		return hasAnswer(fromEvents) ? fromEvents : harvestCompletion(frames, fallbackModel) || fromEvents
	}
	return harvestCompletion(unknownFrames, fallbackModel) as ChatCompletionLike | null
}

/**
 * A completion is only usable when it says something or bills something: an empty
 * one is how a mis-parsed stream hides, so callers can fall back to the harvest.
 */
