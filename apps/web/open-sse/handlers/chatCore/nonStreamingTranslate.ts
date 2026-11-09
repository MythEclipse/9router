/** Non-streaming translate. */
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
import { bridgeOpenAIChatResponse, openAICompletionToResponses } from "./nonStreamingCoerce.ts"
import {
	buildRequestDetail,
	extractRequestConfig,
	extractUsageFromResponse,
	formatDoneLine,
	saveUsageStats,
} from "./requestDetail.ts"
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.ts"

export function translateNonStreamingResponse(
	responseBody,
	targetFormat,
	sourceFormat,
	customToolNames = null,
) {
	if (targetFormat === sourceFormat) return responseBody
	// Provider responded in OpenAI Chat Completions shape but the client speaks
	// Responses API - convert so tool_calls/text surface as Responses `output`.
	if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES) {
		return openAICompletionToResponses(responseBody, customToolNames)
	}
	if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.CLAUDE) {
		return openAICompletionToClaudeMessage(responseBody)
	}
	if (targetFormat === FORMATS.OPENAI) return responseBody

	// Gemini / Antigravity
	if (
		targetFormat === FORMATS.GEMINI ||
		targetFormat === FORMATS.ANTIGRAVITY ||
		targetFormat === FORMATS.GEMINI_CLI ||
		targetFormat === FORMATS.VERTEX
	) {
		const response = responseBody.response || responseBody
		if (!response?.candidates?.[0]) return responseBody

		const candidate = response.candidates[0]
		const content = candidate.content
		const usage = response.usageMetadata || responseBody.usageMetadata
		let textContent = "",
			reasoningContent = ""
		const toolCalls = []

		if (content?.parts) {
			for (const part of content.parts) {
				if (part.thought === true && part.text) reasoningContent += part.text
				else if (part.text !== undefined) textContent += part.text
				if (part.functionCall) {
					toolCalls.push({
						id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
						type: "function",
						function: {
							name: part.functionCall.name,
							arguments: JSON.stringify(part.functionCall.args || {}),
						},
					})
				}
				// Handle inline image data (from image generation models)
				const inlineData = part.inlineData || part.inline_data
				if (inlineData?.data) {
					const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png"
					textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`
				}
			}
		}

		const message: Record<string, unknown> = { role: "assistant" }
		if (textContent) message.content = textContent
		if (reasoningContent) message.reasoning_content = reasoningContent
		if (toolCalls.length > 0) message.tool_calls = toolCalls
		if (!message.content && !message.tool_calls) message.content = ""

		let finishReason = (candidate.finishReason || "stop").toLowerCase()
		if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls"

		const result: {
			id: string
			object: string
			created: number
			model: string
			choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>
			usage?: {
				prompt_tokens: number
				completion_tokens: number
				total_tokens: number
				prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number }
				completion_tokens_details?: { reasoning_tokens: number }
			}
		} = {
			id: `chatcmpl-${response.responseId || Date.now()}`,
			object: "chat.completion",
			created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
			model: response.modelVersion || "gemini",
			choices: [{ index: 0, message, finish_reason: finishReason }],
		}

		if (usage) {
			const thoughts = usage.thoughtsTokenCount || 0
			const cached = usage.cachedContentTokenCount || 0
			// Mirror the streaming extractor (translator/concerns/usage.ts): thoughts
			// are output-side tokens, and cached prompt tokens are a subset of
			// promptTokenCount. The old shape added thoughts to prompt_tokens, which
			// both mis-split the turn and hid the cache read.
			result.usage = {
				prompt_tokens: usage.promptTokenCount || 0,
				completion_tokens: (usage.candidatesTokenCount || 0) + thoughts,
				total_tokens: usage.totalTokenCount || 0,
			}
			if (cached > 0) {
				result.usage.prompt_tokens_details = { cached_tokens: cached }
			}
			if (thoughts > 0) {
				result.usage.completion_tokens_details = { reasoning_tokens: thoughts }
			}
		}
		// The client's format decides the body. This branch used to return the
		// OpenAI shape unconditionally, so an Anthropic client calling a Gemini
		// model non-streaming received `object:"chat.completion"` with `usage:{}`
		// instead of a `message` — a protocol violation, and the cache read never
		// reached it.
		if (sourceFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(result)
		return result
	}

	// Claude
	if (targetFormat === FORMATS.CLAUDE) {
		// Always translate a Claude-format body to OpenAI, even if `content` is
		// missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
		// and returns `content: null`). Returning the raw body would leave the
		// OpenAI client without a `choices` array and surface as a UI test error.
		// Early return if the response is already in OpenAI format (has choices array)
		// or if it has content as a non-array value (likely a different non-Claude format).
		// Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
		// the request was translated to Claude format - the targetFormat is Claude but the
		// actual response is OpenAI-native and needs no further translation.
		if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content)))
			return responseBody

		let textContent = "",
			thinkingContent = ""
		const toolCalls = []

		for (const block of responseBody.content || []) {
			if (block.type === "text") {
				// Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
				const raw = block.text ?? ""
				const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "")
				textContent += text
			} else if (block.type === "thinking") thinkingContent += block.thinking || ""
			else if (block.type === "tool_use") {
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
				})
			}
		}

		const message: Record<string, unknown> = { role: "assistant" }
		if (textContent) message.content = textContent
		if (thinkingContent) message.reasoning_content = thinkingContent
		if (toolCalls.length > 0) message.tool_calls = toolCalls
		if (!message.content && !message.tool_calls) message.content = ""

		let finishReason = responseBody.stop_reason || "stop"
		if (finishReason === "end_turn") finishReason = "stop"
		if (finishReason === "tool_use") finishReason = "tool_calls"

		const result: {
			id: string
			object: string
			created: number
			model: string
			choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>
			usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
		} = {
			id: `chatcmpl-${responseBody.id || Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: responseBody.model || "claude",
			choices: [{ index: 0, message, finish_reason: finishReason }],
		}

		if (responseBody.usage) {
			result.usage = {
				prompt_tokens: responseBody.usage.input_tokens || 0,
				completion_tokens: responseBody.usage.output_tokens || 0,
				total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0),
			}
		}
		return result
	}

	// Ollama
	if (targetFormat === FORMATS.OLLAMA) {
		return ollamaBodyToOpenAI(responseBody)
	}

	return responseBody
}
