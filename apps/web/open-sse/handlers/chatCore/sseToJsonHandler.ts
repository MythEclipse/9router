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
import {
	chatCompletionToResponses,
	parseSSEToOpenAIResponse,
	pickAssistantMessageForChatCompletion,
} from "./sseJsonParseA.ts"

export { parseSSEToOpenAIResponse } from "./sseJsonParseA.ts"
export {
	accumulateOpenAIChunks,
	harvestCompletion,
	hasAnswer,
	translateFramesToChunks,
} from "./sseJsonParseB.ts"

import { buildClientFormatResponse } from "./sseJsonFinalize.ts"
import { handleStandardSseToJson } from "./sseJsonStandard.ts"

export interface ForcedSSEToJsonContext {
	providerResponse: Response
	sourceFormat: string
	targetFormat: string
	provider: string
	model: string
	body: Record<string, unknown>
	stream: boolean
	translatedBody: Record<string, unknown> | null
	finalBody: Record<string, unknown> | null
	requestStartTime: number
	connectionId?: string
	apiKey?: string
	requestedModel?: string
	clientRawRequest?: {
		headers?: Record<string, string>
		endpoint?: string
		body?: Record<string, unknown>
		[key: string]: unknown
	}
	onRequestSuccess?: () => void | Promise<void>
	customToolNames?: unknown
	toolNameMap?: unknown
	webSearchPlan?: unknown
	runSearch?: unknown
	trackDone: () => void
	appendLog: (extra: Record<string, unknown>) => Promise<void>
	reqTag?: string
	log?: {
		line?: (tag: string, icon: string, message: string) => void
		debug?: (tag: string, message: string) => void
		warn?: (tag: string, message: string) => void
		info?: (tag: string, message: string) => void
		[key: string]: unknown
	}
	modelMultipliers?: unknown
	isAntiProbe?: boolean
	pxpipeSummary?: unknown
	alias?: string
}

export async function handleForcedSSEToJson({
	providerResponse,
	sourceFormat,
	targetFormat,
	provider,
	model,
	body,
	stream,
	translatedBody,
	finalBody,
	requestStartTime,
	connectionId,
	apiKey,
	requestedModel,
	clientRawRequest,
	onRequestSuccess,
	customToolNames,
	toolNameMap,
	webSearchPlan,
	runSearch,
	trackDone,
	appendLog,
	reqTag,
	log,
	modelMultipliers = null,
	isAntiProbe = false,
}: ForcedSSEToJsonContext) {
	const contentType = providerResponse.headers.get("content-type") || ""
	const isSSE =
		contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider))
	if (!isSSE) return null // not handled here
	const alias = calledModelName(requestedModel, model)

	trackDone()

	const ctx = {
		provider,
		model,
		connectionId,
		requestedModel,
		request: extractRequestConfig(body, stream),
		providerRequest: finalBody || translatedBody || null,
	}

	// Codex/Responses API SSE path
	// Branch on the UPSTREAM format (targetFormat = format we spoke to the provider in),
	// not the client format: a Responses-API client behind a chat-native forced-streaming
	// provider still receives chat SSE chunks, which must go through the standard path.
	const isCodexResponsesApi =
		isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES
	if (isCodexResponsesApi) {
		try {
			const jsonResponse = await convertResponsesStreamToJson(providerResponse.body)
			if (onRequestSuccess) await onRequestSuccess()

			const usage: Record<string, number> = jsonResponse.usage || {}
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

			// Same cache-inclusive total for the recorded detail, so the DB and the
			// client-facing usage can never disagree.
			const inTokensForLog =
				(usage.input_tokens || 0) +
				(usage.cache_read_input_tokens || usage.cached_tokens || 0) +
				(usage.cache_creation_input_tokens || 0)
			const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output)
			const totalLatency = Date.now() - requestStartTime

			saveRequestDetail(
				buildRequestDetail(
					{
						...ctx,
						latency: { ttft: totalLatency, total: totalLatency },
						tokens: { prompt_tokens: inTokensForLog, completion_tokens: usage.output_tokens || 0 },
						response: {
							content: textContent,
							thinking: null,
							finish_reason: jsonResponse.status || "unknown",
						},
						status: "success",
					},
					{ endpoint: clientRawRequest?.endpoint || null },
				),
			).catch(() => {})

			// Client is Responses API → return as-is
			if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
				applyModelAlias(jsonResponse, alias)
				return {
					success: true,
					response: new Response(JSON.stringify(restoreToolNames(jsonResponse, toolNameMap)), {
						headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
					}),
				}
			}

			return await buildClientFormatResponse({
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
			})
		} catch (err) {
			if (isAbortError(err)) {
				log?.debug?.(reqTag, "Forced Responses SSE→JSON cancelled after client disconnect")
				return createErrorResult(499, "Request aborted")
			}
			console.error("[ChatCore] Responses API SSE→JSON failed:", err)
			return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON")
		}
	}

	return await handleStandardSseToJson({
		providerResponse,
		sourceFormat,
		targetFormat,
		provider,
		model,
		body,
		stream,
		translatedBody,
		finalBody,
		requestStartTime,
		connectionId,
		apiKey,
		requestedModel,
		clientRawRequest,
		onRequestSuccess,
		customToolNames,
		toolNameMap,
		webSearchPlan,
		runSearch,
		trackDone,
		appendLog,
		reqTag,
		log,
		modelMultipliers,
		isAntiProbe,
		alias,
	} as ForcedSSEToJsonContext)
}
