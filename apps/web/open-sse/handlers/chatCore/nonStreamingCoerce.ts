/** Non-streaming coercion helpers. */
import { saveRequestDetail } from "@/lib/usageDb"
import { HTTP_STATUS, MAX_JSON_BODY_SIZE } from "../../config/runtimeConfig.ts"
import {
	SAFEGUARD_STATUS_UNAVAILABLE,
	SAFEGUARD_STATUS_UNSUPPORTED,
} from "../../config/safeguardsConstants.ts"
import { saveToSemanticCache } from "../../rtk/semanticCache.ts"
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.ts"
import { openAICompletionToClaudeMessage } from "../../translator/concerns/claudeMessage.ts"
import { applyJsonGuard } from "../../translator/concerns/jsonGuard.ts"
import { applyOpenAIToolBridge } from "../../translator/concerns/toolBridge.ts"
import { rescueResponse } from "../../translator/concerns/toolCallRescue.ts"
import { FORMATS } from "../../translator/formats.ts"
import { needsTranslation } from "../../translator/index.ts"
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.ts"
import { RESPONSES_ITEM, ROLE } from "../../translator/schema/index.ts"
import { decloakToolNames } from "../../utils/claudeCloaking.ts"
import { createErrorResult } from "../../utils/error.ts"
import { applyModelAlias, calledModelName } from "../../utils/modelAlias.ts"
import { restoreToolNames } from "../../utils/opencodeFingerprint.ts"
import { mergeFragmentedToolCalls } from "../../utils/toolCallRepair.ts"
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.ts"
import {
	addBufferToUsage,
	applyUsageMultipliers,
	filterUsageForFormat,
} from "../../utils/usageTracking.ts"
import { reviewAndBuildSafeguardResults } from "../safeguardsBridge.ts"
import { resolveDecisionCredentials } from "../safeguardsCredentials.ts"
import {
	attachSafeguardResults,
	buildUnavailableResults,
	collectToolUseIds,
} from "../safeguardsProtocol.ts"
import {
	buildRequestDetail,
	extractRequestConfig,
	extractUsageFromResponse,
	formatDoneLine,
	saveUsageStats,
} from "./requestDetail.ts"
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.ts"

const MAX_SSE_TEXT_SIZE = 5 * 1024 * 1024 // 5MB

export function parseToolArguments(value) {
	if (!value) return {}
	if (typeof value === "object") return value
	try {
		return JSON.parse(value)
	} catch {
		return {}
	}
}

/**
 * OpenAI Tool Bridge - response side, non-streaming.
 *
 * A text-only provider (browser-session models with `tools: false`) answers a
 * tool request in prose, so the client receives a plain string and waits for a
 * tool_call that never arrives. The model's own answer is where the invocation
 * is declared - `{"name": ...}`, `<tool_use>`, `to=read_file {...}` - so
 * rewriting it is a FORMAT repair on content the model wrote, never a guess
 * about intent.
 *
 * Both client shapes are covered: the OpenAI chat envelope
 * (`choices[0].message.content`) and the Claude envelope (`content[]` text
 * blocks). The tool catalogue comes from the request the client actually sent,
 * which is the only trustworthy list of what may be called.
 */
export function bridgeOpenAIChatResponse(response, body) {
	// The catalogue travels with the request in whichever shape the client used.
	const catalogue = body?._openaiToolBridge || {}
	const sourceTools =
		Array.isArray(body?.tools) && body.tools.length
			? body.tools
			: Array.isArray(catalogue.tools)
				? catalogue.tools
				: undefined
	const sourceFunctions =
		Array.isArray(body?.functions) && body.functions.length
			? body.functions
			: Array.isArray(catalogue.functions)
				? catalogue.functions
				: undefined

	const args = {
		tools: sourceTools,
		functions: sourceFunctions,
	}

	let applied = 0

	// OpenAI chat envelope.
	const message = response?.choices?.[0]?.message
	if (message && typeof message.content === "string" && !message.tool_calls) {
		const out = applyOpenAIToolBridge({ content: message.content }, args)
		if (out.openaiToolBridge?.applied) {
			message.content = out.content
			message.tool_calls = out.tool_calls
			applied += out.tool_calls.length
		}
	}

	// Claude envelope: content is an array of blocks; the bridge reads text blocks.
	if (Array.isArray(response?.content) && !response?.tool_calls) {
		const texts = response.content.filter((b) => b?.type === "text" && typeof b.text === "string")
		if (texts.length) {
			const joined = texts.map((b) => b.text).join("\n")
			const out = applyOpenAIToolBridge({ content: joined }, args)
			if (out.openaiToolBridge?.applied) {
				// Keep the prose as a text block (it explains the call) and add tool_use
				// blocks after it, mirroring what a natively tool-capable model emits.
				texts[0].text = out.content
				for (let i = 1; i < texts.length; i++) texts[i].text = ""
				for (const tc of out.tool_calls) {
					response.content.push({
						type: "tool_use",
						id: tc.id,
						name: tc.function.name,
						input: parseToolArguments(tc.function.arguments),
					})
				}
				applied += out.tool_calls.length
			}
		}
	}

	return applied
}
/**
 * Convert an OpenAI Chat Completions non-streaming response body into the
 * OpenAI Responses API shape. Used when a Responses-format client (e.g. Codex)
 * is routed to a Chat Completions upstream and `stream:false` - the streaming
 * path already emits Responses events, but the JSON path returned a raw
 * `chat.completion` body, so tool_calls were invisible to Responses clients.
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

export function openAICompletionToResponses(responseBody, customToolNames = null) {
	const choice = responseBody?.choices?.[0]
	if (!choice) return responseBody

	const message = choice.message || {}
	const output: Array<Record<string, unknown>> = []

	// Reasoning → a reasoning item (summary text), mirroring the streaming path.
	const reasoning = message.reasoning_content || message.reasoning
	if (typeof reasoning === "string" && reasoning.length > 0) {
		output.push({
			type: RESPONSES_ITEM.REASONING,
			summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
		})
	}

	// Assistant text → a message item with output_text content.
	const text = typeof message.content === "string" ? message.content : ""
	if (text.length > 0) {
		output.push({
			type: RESPONSES_ITEM.MESSAGE,
			role: ROLE.ASSISTANT,
			content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
		})
	}

	// tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
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
	const status =
		choice.finish_reason === "tool_calls"
			? "completed"
			: choice.finish_reason === "stop"
				? "completed"
				: choice.finish_reason || "completed"

	return {
		id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
		object: "response",
		created_at: responseBody.created || Math.floor(Date.now() / 1000),
		model: responseBody.model || "unknown",
		status,
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
 * Translate non-streaming response body from provider format → OpenAI format.
 */
