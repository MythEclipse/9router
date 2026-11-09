/** SSE→JSON standard path. */
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

import { chatCompletionToResponses, parseSSEToOpenAIResponse } from "./sseJsonParseA.ts"
import type { ForcedSSEToJsonContext } from "./sseToJsonHandler.ts"

export async function handleStandardSseToJson(ctx: ForcedSSEToJsonContext) {
	const {
		providerResponse,
		provider,
		model,
		trackDone,
		appendLog,
		onRequestSuccess,
		modelMultipliers,
		log,
		reqTag,
		connectionId,
		apiKey,
		requestedModel,
		clientRawRequest,
		requestStartTime,
		body,
		stream,
		translatedBody,
		finalBody,
		pxpipeSummary,
		sourceFormat,
		targetFormat,
		customToolNames,
		toolNameMap,
		webSearchPlan,
		runSearch,
		isAntiProbe,
		alias,
	} = ctx
	// Standard Chat Completions SSE path
	try {
		const sseText = await providerResponse.text()
		const parsed = parseSSEToOpenAIResponse(sseText, model)
		if (!parsed)
			return createErrorResult(
				HTTP_STATUS.BAD_GATEWAY,
				"Invalid SSE response for non-streaming request",
			)
		if (parsed.error) {
			// Structured error chunks may carry the real upstream status (e.g. the
			// Qoder executor emits status 403 for billing envelopes). Preserve it so
			// the account loop locks/falls back on the right status instead of a
			// generic 502. Anything outside 400-599 still maps to 502.
			const upstreamStatus = Number(parsed.error.status)
			const status =
				Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
					? upstreamStatus
					: HTTP_STATUS.BAD_GATEWAY
			return createErrorResult(status, parsed.error.message || "Upstream SSE stream failed")
		}

		if (onRequestSuccess) await onRequestSuccess()

		let usage = parsed.usage || {}
		if (modelMultipliers && usage) {
			usage = applyUsageMultipliers(usage, modelMultipliers)
		}
		appendLog({ tokens: usage, status: "200 OK" })
		saveUsageStats({
			provider,
			model,
			tokens: usage,
			connectionId,
			apiKey,
			requestedModel,
			endpoint: clientRawRequest?.endpoint,
			silent: true,
			// The stream is consumed before this point, so the duration is complete.
			latency: { total: Date.now() - requestStartTime },
		})
		if (log?.line)
			log.line(
				reqTag,
				"📊",
				formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }),
			)

		const totalLatency = Date.now() - requestStartTime
		saveRequestDetail(
			buildRequestDetail(
				{
					...ctx,
					latency: { ttft: totalLatency, total: totalLatency },
					tokens: usage,
					response: {
						content: parsed.choices?.[0]?.message?.content || null,
						thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
						finish_reason: parsed.choices?.[0]?.finish_reason || "unknown",
					},
					status: "success",
				},
				{ endpoint: clientRawRequest?.endpoint || null },
			),
		).catch(() => {})

		if (usage && Object.keys(usage).length > 0) parsed.usage = usage
		if (isAntiProbe && requestedModel && parsed) parsed.model = requestedModel

		// Strip reasoning_content only when content is non-empty.
		// When content is empty (e.g. thinking models that used all tokens for reasoning),
		// reasoning_content is the only useful output and must be preserved.
		// Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
		if (parsed?.choices) {
			for (const choice of parsed.choices) {
				if (choice?.message?.reasoning_content && choice.message.content) {
					delete choice.message.reasoning_content
				}
			}
		}

		// A Responses-format client (e.g. Codex) forced this provider to stream,
		// but wants JSON back. parseSSEToOpenAIResponse yields a Chat Completions
		// body; convert it to the Responses `output` shape so tool_calls are not
		// lost on the non-streaming return path. Inlined (not imported from
		// nonStreamingHandler.js) to avoid a circular import: nonStreamingHandler
		// already imports parseSSEToOpenAIResponse from this module.
		// Everything above is logging; the document leaving here must name the called model.
		applyModelAlias(parsed, alias)
		const finalBody =
			sourceFormat === FORMATS.OPENAI_RESPONSES
				? chatCompletionToResponses(parsed, customToolNames)
				: sourceFormat === FORMATS.CLAUDE
					? openAICompletionToClaudeMessage(parsed)
					: parsed

		if (sourceFormat === FORMATS.CLAUDE) {
			await attachWebSearchToClaudeBody({ responseBody: finalBody, webSearchPlan, runSearch, log })
		}

		return {
			success: true,
			response: new Response(JSON.stringify(restoreToolNames(finalBody, toolNameMap)), {
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			}),
		}
	} catch (err) {
		if (isAbortError(err)) {
			log?.debug?.(reqTag, "Forced Chat Completions SSE→JSON cancelled after client disconnect")
			return createErrorResult(499, "Request aborted")
		}
		console.error("[ChatCore] Chat Completions SSE→JSON failed:", err)
		return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON")
	}
}
