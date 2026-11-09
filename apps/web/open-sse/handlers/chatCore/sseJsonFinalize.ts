/** SSE→JSON finalize. */
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

export async function buildClientFormatResponse(ctx) {
	const {
		jsonResponse,
		usage,
		textContent,
		sourceFormat,
		model,
		alias,
		toolNameMap,
		webSearchPlan,
		runSearch,
		log,
	} = ctx
	// Build client-format response.
	// input_tokens EXCLUDES cached tokens on cache-capable upstreams, so summing
	// only input+output under-reports prompt_tokens - measured: 2012 reported
	// where the real prompt was ~5344 with 5332 served from cache. Fold the cache
	// counters in, and keep them visible in prompt_tokens_details so a client can
	// tell a cache hit from a small prompt.
	const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || 0
	const cacheCreate = usage.cache_creation_input_tokens || 0
	const inTokens = (usage.input_tokens || 0) + cacheRead + cacheCreate
	const outTokens = usage.output_tokens || 0
	const cacheDetails =
		cacheRead > 0 || cacheCreate > 0
			? {
					prompt_tokens_details: {
						...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
						...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}),
					},
				}
			: {}
	let finalResp

	// Extract tool calls from Responses API output (function_call items)
	const funcCallItems = (jsonResponse.output || []).filter((item) => item.type === "function_call")
	const toolCalls = funcCallItems.map((item, idx) => ({
		id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
		type: "function",
		function: {
			name: item.name,
			arguments:
				typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
		},
	}))
	const hasToolCalls = toolCalls.length > 0

	if (
		sourceFormat === FORMATS.ANTIGRAVITY ||
		sourceFormat === FORMATS.GEMINI ||
		sourceFormat === FORMATS.GEMINI_CLI
	) {
		finalResp = {
			response: {
				candidates: [
					{
						content: { role: "model", parts: [{ text: textContent || "" }] },
						finishReason: "STOP",
						index: 0,
					},
				],
				usageMetadata: {
					promptTokenCount: inTokens,
					candidatesTokenCount: outTokens,
					totalTokenCount: inTokens + outTokens,
				},
				modelVersion: model,
				responseId: jsonResponse.id || `resp_${Date.now()}`,
			},
		}
	} else {
		const message: Record<string, unknown> = {
			role: "assistant",
			content: textContent || (hasToolCalls ? null : ""),
		}
		if (hasToolCalls) message.tool_calls = toolCalls
		const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done"
		const finishReason = hasToolCalls
			? "tool_calls"
			: responseDone
				? "stop"
				: jsonResponse.status || "stop"
		finalResp = {
			id: jsonResponse.id || `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
			model: (jsonResponse as { model?: string }).model || model,
			choices: [{ index: 0, message, finish_reason: finishReason }],
			usage: {
				prompt_tokens: inTokens,
				completion_tokens: outTokens,
				total_tokens: inTokens + outTokens,
				...cacheDetails,
			},
		}
	}

	applyModelAlias(finalResp, alias)
	if (sourceFormat === FORMATS.CLAUDE) {
		finalResp = openAICompletionToClaudeMessage(finalResp)
		finalResp = await attachWebSearchToClaudeBody({
			responseBody: finalResp,
			webSearchPlan,
			runSearch,
			log,
		})
	}

	return {
		success: true,
		response: new Response(JSON.stringify(restoreToolNames(finalResp, toolNameMap)), {
			headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		}),
	}
}
