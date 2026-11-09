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

const MAX_SSE_TEXT_SIZE = 5 * 1024 * 1024

import { bridgeOpenAIChatResponse } from "./nonStreamingCoerce.ts"
import { finalizeNonStreamingResponse } from "./nonStreamingFinalize.ts"
import { attachReviewToClaudeBody } from "./nonStreamingSafeguards.ts"
import { translateNonStreamingResponse } from "./nonStreamingTranslate.ts"

export { bridgeOpenAIChatResponse } from "./nonStreamingCoerce.ts"
export { attachReviewToClaudeBody } from "./nonStreamingSafeguards.ts"
export { translateNonStreamingResponse } from "./nonStreamingTranslate.ts"

export async function handleNonStreamingResponse({
	providerResponse,
	provider,
	model,
	sourceFormat,
	targetFormat,
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
	reqLogger,
	toolNameMap,
	customToolNames,
	trackDone,
	appendLog,
	pxpipe,
	reqTag,
	log,
	pluginResult,
	modelMultipliers = null,
	isAntiProbe = false,
}) {
	trackDone()

	// Validate providerResponse
	if (!providerResponse || typeof providerResponse !== "object") {
		const _err = new Error("Invalid provider response")
		appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
		return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Internal server error")
	}

	// Validate headers
	if (!providerResponse.headers || typeof providerResponse.headers.get !== "function") {
		const _err = new Error("Invalid response headers")
		appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
		return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid response headers")
	}

	const contentType = providerResponse.headers.get("content-type") || ""
	let responseBody
	// Which format `responseBody` ends up in: the provider's own when it answers
	// normally, the OpenAI pivot when we had to rebuild it out of a stream.
	let responseBodyFormat = targetFormat

	if (contentType.includes("text/event-stream")) {
		let sseText = ""
		try {
			sseText = await providerResponse.text()
		} catch (err) {
			appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
			console.error(`[ChatCore] Failed to read SSE text from ${provider}:`, err.message)
			return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to read SSE response")
		}

		// Prevent DoS via extremely large SSE text
		if (sseText.length > MAX_SSE_TEXT_SIZE) {
			appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
			console.error(`[ChatCore] SSE text too large from ${provider}: ${sseText.length} bytes`)
			return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "SSE response too large")
		}

		const parsed = parseSSEToOpenAIResponse(sseText, model)
		if (!parsed) {
			// The message alone cannot tell an empty upstream stream from a dialect
			// the parser has never seen, and both used to look identical in the log.
			// A bounded prefix settles it without dumping a whole transcript.
			console.error(
				`[ChatCore] No completion in SSE from ${provider} (${sseText.length} bytes): ${sseText.slice(0, 200)}`,
			)
			appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
			return createErrorResult(
				HTTP_STATUS.BAD_GATEWAY,
				"Invalid SSE response for non-streaming request",
				undefined,
				null,
				false,
				sourceFormat,
			)
		}
		if (parsed.error) {
			const upstreamStatus = Number(parsed.error.status)
			const status =
				Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
					? upstreamStatus
					: HTTP_STATUS.BAD_GATEWAY
			appendLog({ status: `FAILED ${status}` })
			return createErrorResult(
				status,
				parsed.error.message || "Upstream SSE stream failed",
				undefined,
				null,
				false,
				sourceFormat,
			)
		}
		responseBody = parsed
		responseBodyFormat = FORMATS.OPENAI
	} else {
		try {
			// Use safeJsonParse to limit JSON body size
			let bodyText = ""
			try {
				bodyText = await providerResponse.text()
			} catch {
				appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
				return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to read response body")
			}

			if (bodyText.length > MAX_JSON_BODY_SIZE) {
				appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
				console.error(`[ChatCore] JSON body too large from ${provider}: ${bodyText.length} bytes`)
				return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "JSON response too large")
			}

			responseBody = JSON.parse(bodyText)
		} catch (err) {
			appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
			console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message)
			return createErrorResult(
				HTTP_STATUS.BAD_GATEWAY,
				`Invalid JSON response from ${provider}`,
				undefined,
				null,
				false,
				sourceFormat,
			)
		}
	}

	// Unwrap before any consumer reads choices/usage so non-stream clients get a
	// bare OpenAI body and usage tracking sees data.usage. No-op unless the
	// provider opts in via transport.quirks.clineEnvelope.
	responseBody = unwrapClineEnvelope(responseBody, provider)

	// Some [OI] gateways answer a non-streaming request with the raw delta
	// sequence in `message.tool_calls` (one id-bearing entry then a run of
	// argument fragments). Fold them back together before anything reads the
	// calls — a Claude client would otherwise get one `tool_use` per fragment,
	// each with an empty name and `input:{}`.
	const mergedFragments = mergeFragmentedToolCalls(responseBody)
	if (mergedFragments > 0) {
		log?.debug?.("TOOLREPAIR", `${mergedFragments} fragmented tool_call entries merged`)
	}

	reqLogger.logProviderResponse(
		providerResponse.status,
		providerResponse.statusText,
		providerResponse.headers,
		responseBody,
	)
	if (onRequestSuccess) {
		Promise.resolve()
			.then(onRequestSuccess)
			.catch((err) => {
				console.error("[ChatCore] onRequestSuccess failed:", err?.message || err)
			})
	}

	// Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
	responseBody = decloakToolNames(responseBody, toolNameMap)

	let usage = extractUsageFromResponse(responseBody)
	if (modelMultipliers && usage) {
		usage = applyUsageMultipliers(usage, modelMultipliers)
	}
	appendLog({ tokens: usage, status: "200 OK" })
	// Measured once, used by both the usage row and the log line, so the two cannot disagree
	// about how long the call took.
	const elapsedMs = Date.now() - requestStartTime
	saveUsageStats({
		provider,
		model,
		tokens: usage,
		connectionId,
		apiKey,
		requestedModel,
		endpoint: clientRawRequest?.endpoint,
		silent: true,
		// No first token to time here, only the whole call.
		latency: { total: elapsedMs },
	})
	if (log?.line)
		log.line(
			reqTag,
			"📊",
			formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }),
		)

	const translatedResponse = needsTranslation(responseBodyFormat, sourceFormat)
		? translateNonStreamingResponse(responseBody, responseBodyFormat, sourceFormat, customToolNames)
		: responseBody
	const isClaudeMessageResponse =
		sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message"
	// Responses-format translation produces a `object:"response"` body with no
	// `choices`; skip the Chat-Completions-specific post-processing below for it.
	// `responseBodyFormat` is the provider side of the pair; a client that speaks
	// Responses gets an `object:"response"` body with no `choices` to post-process.
	const isResponsesResponse =
		(responseBodyFormat === FORMATS.OPENAI_RESPONSES || sourceFormat === FORMATS.OPENAI_RESPONSES) &&
		translatedResponse?.object === "response"

	return await finalizeNonStreamingResponse({
		translatedResponse,
		translatedBody,
		body,
		provider,
		model,
		log,
		sourceFormat,
		responseBodyFormat,
		isClaudeMessageResponse,
		isResponsesResponse,
		toolNameMap,
		providerResponse,
		pxpipe,
		connectionId,
		apiKey,
		requestedModel,
		clientRawRequest,
		reqTag,
		requestStartTime,
		responseBody,
		usage,
		elapsedMs,
		onRequestSuccess,
		modelMultipliers,
		pluginResult,
		isAntiProbe,
		reqLogger,
		stream,
		finalBody,
	})
}
