/** Non-streaming finalize. */
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
import { bridgeOpenAIChatResponse } from "./nonStreamingCoerce.ts"
import {
	buildRequestDetail,
	extractRequestConfig,
	extractUsageFromResponse,
	formatDoneLine,
	saveUsageStats,
} from "./requestDetail.ts"
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.ts"

export async function finalizeNonStreamingResponse(ctx) {
	const {
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
	} = ctx
	// Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
	if (translatedResponse?.choices?.[0]) {
		const choice = translatedResponse.choices[0]
		const msg = choice.message
		const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
		if (hasToolCalls && choice.finish_reason !== "tool_calls") {
			choice.finish_reason = "tool_calls"
		}
	}

	// A call the client cannot satisfy ends the turn: `Invalid args for tool "Bash":
	// must have required property 'command'` is the client validating against the
	// schema this very request declared, and it throws rather than continuing. Run
	// after the finish_reason fix so a dropped call can correct that reason back
	// and leave a well-formed answer instead of a half-finished tool turn.
	if (Array.isArray(translatedBody?.tools) && translatedBody.tools.length > 0) {
		const rescued = rescueResponse(translatedResponse, translatedBody.tools)
		if (rescued.renamed || rescued.recovered || rescued.dropped) {
			log?.debug?.(
				"TOOLRESCUE",
				`${rescued.renamed} renamed, ${rescued.recovered} recovered, ${rescued.dropped} dropped (response)`,
			)
		}
	}

	// Global response repair: a provider with no native tool support may answer
	// in prose or a model-native markup dialect. The invocation is already in
	// the model's answer, so promoting it to tool_calls is a format repair, not
	// a guess. The bridge only accepts tools declared by this request.
	if (translatedResponse && typeof translatedResponse === "object") {
		const bridged = bridgeOpenAIChatResponse(translatedResponse, body)
		if (bridged > 0) {
			log?.debug?.("TOOLBRIDGE", `${bridged} call(s) recovered from prose · ${provider}/${model}`)
		}
	}

	// JSON Guard (opt-in per model): make machine-readable output parseable again.
	// Runs after translation and after the tool rescue, because both rewrite the
	// tool_calls this reads. Only the non-streaming path reaches here - a streaming
	// answer's tool arguments arrive as fragments and are forwarded as they land,
	// so there is no complete value to repair without buffering every tool call.
	if (
		pluginResult?.isJsonGuardActive &&
		translatedResponse &&
		typeof translatedResponse === "object"
	) {
		const guarded = applyJsonGuard(translatedResponse, translatedBody?.tools)
		if (guarded.changed) {
			const s = guarded.stats
			log?.debug?.(
				"JSONGUARD",
				`${s.textRepaired} text repaired, ${s.argsRepaired} args repaired, ${s.argsDropped} args dropped, ${s.argsCleaned} schema-cleaned (${s.argsFilled} filled, ${s.argsMissing} still missing)`,
			)
		} else {
			log?.debug?.("JSONGUARD", "checked, nothing to repair")
		}
	}

	// Ensure OpenAI-required fields
	if (!isClaudeMessageResponse && !isResponsesResponse) {
		if (!translatedResponse.object) translatedResponse.object = "chat.completion"
		if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000)
	}

	// Strip Azure-specific fields
	if (!isClaudeMessageResponse && !isResponsesResponse) {
		delete translatedResponse.prompt_filter_results
		if (translatedResponse?.choices) {
			for (const choice of translatedResponse.choices) delete choice.content_filter_results
		}
	}

	if (translatedResponse?.usage) {
		if (modelMultipliers) {
			translatedResponse.usage = applyUsageMultipliers(translatedResponse.usage, modelMultipliers)
		}
		translatedResponse.usage = filterUsageForFormat(
			addBufferToUsage(translatedResponse.usage),
			sourceFormat,
		)
	}

	if (
		(isAntiProbe || requestedModel) &&
		translatedResponse &&
		typeof translatedResponse === "object"
	) {
		if (requestedModel && translatedResponse.model) {
			translatedResponse.model = requestedModel
		}
		if (isAntiProbe) {
			delete translatedResponse.system_fingerprint
		}
	}

	// Rescue zero-output tokens for clients:
	// When content is empty (e.g. thinking models that used all tokens for reasoning),
	// promote reasoning_content into content so standard OpenAI clients don't see 0 output tokens.
	if (!isClaudeMessageResponse && !isResponsesResponse && translatedResponse?.choices) {
		for (const choice of translatedResponse.choices) {
			if (
				(!choice?.message?.content || !choice.message.content.trim()) &&
				choice?.message?.reasoning_content
			) {
				choice.message.content = choice.message.reasoning_content
			} else if (
				(!choice?.message?.content || !choice.message.content.trim()) &&
				!choice?.message?.tool_calls
			) {
				const reason = choice?.finish_reason
				choice.message.content =
					reason === "length"
						? "[Model stopped: max_tokens limit reached before output could be generated. Please increase max_tokens.]"
						: reason === "content_filter"
							? "[Model stopped: Output filtered by upstream provider content policy.]"
							: "[The model generated zero output tokens. Upstream completed with empty response.]"
			}
		}
	}

	// Log first: the operator has to see the model that actually served the call.
	reqLogger.logConvertedResponse(translatedResponse)
	applyModelAlias(translatedResponse, calledModelName(requestedModel, model))

	// Save the answer the client is about to receive, so the next identical question does not
	// reach the provider at all. This call was missing entirely: the cache had a read path and
	// no write path, so it could never hit.
	saveToSemanticCache(body, `${provider}/${model}`, translatedResponse)

	const totalLatency = Date.now() - requestStartTime
	saveRequestDetail(
		buildRequestDetail(
			{
				provider,
				model,
				connectionId,
				requestedModel,
				latency: { ttft: totalLatency, total: totalLatency },
				tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
				request: extractRequestConfig(body, stream),
				providerRequest: finalBody || translatedBody || null,
				providerResponse: responseBody || null,
				response: {
					content:
						translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
					thinking:
						translatedResponse?.choices?.[0]?.message?.reasoning_content ||
						translatedResponse?.reasoning_content ||
						null,
					finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown",
				},
				pxpipe,
				status: "success",
			},
			{ endpoint: clientRawRequest?.endpoint || null },
		),
	).catch((err) => {
		console.error("[RequestDetail] Failed to save:", err.message)
	})

	return {
		success: true,
		response: new Response(JSON.stringify(restoreToolNames(translatedResponse, toolNameMap)), {
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				...upstreamResponseHeaders(providerResponse.headers),
			},
		}),
	}
}
