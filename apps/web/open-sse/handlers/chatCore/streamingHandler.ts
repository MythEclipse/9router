import { saveRequestDetail } from "@/lib/usageDb"
import { PROVIDERS } from "../../config/providers.ts"
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.ts"
import { tapStreamForCache } from "../../rtk/cacheTap.ts"
import { bridgeTextToolCalls } from "../../translator/concerns/streamToolBridge.ts"
import { FORMATS } from "../../translator/formats.ts"
import { needsTranslation } from "../../translator/index.ts"
import { calledModelName } from "../../utils/modelAlias.ts"
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.ts"
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.ts"
import {
	createPassthroughStreamWithLogger,
	createSSETransformStreamWithLogger,
} from "../../utils/stream.ts"
import { pipeWithDisconnect } from "../../utils/streamHandler.ts"
import { buildStreamErrorBytes } from "../../utils/streamHelpers.ts"
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.ts"
import { applyUsageMultipliers } from "../../utils/usageTracking.ts"
import {
	buildRequestDetail,
	extractRequestConfig,
	formatDoneLine,
	saveUsageStats,
} from "./requestDetail.ts"

import { buildTransformStream, sanitizeErrorMessage } from "./streamingHelpers.ts"
/**
 * Handle streaming response - pipe provider SSE through transform stream to client.
 * Includes comprehensive validation and error handling for security.
 */
export async function handleStreamingResponse({
	providerResponse,
	provider,
	model,
	sourceFormat,
	targetFormat,
	userAgent,
	body,
	stream,
	translatedBody,
	finalBody,
	requestStartTime,
	connectionId,
	apiKey,
	clientRawRequest,
	onRequestSuccess,
	reqLogger,
	toolNameMap,
	customToolNames,
	streamController,
	onStreamComplete,
	streamDetailId,
	pxpipe,
	reqTag,
	log,
	credentials,
	requestedModel,
}) {
	if (onRequestSuccess) {
		Promise.resolve()
			.then(onRequestSuccess)
			.catch((err) => {
				console.error("[ChatCore] onRequestSuccess failed:", err?.message || err)
			})
	}

	// Validate providerResponse before processing
	if (!providerResponse || typeof providerResponse !== "object") {
		const err = new Error("Invalid provider response")
		streamController?.handleError?.(err)
		return {
			success: false,
			response: new Response(JSON.stringify({ error: { message: "Internal server error" } }), {
				status: 500,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			}),
		}
	}

	// Validate response headers
	if (!providerResponse.headers || typeof providerResponse.headers.get !== "function") {
		const err = new Error("Invalid response headers")
		streamController?.handleError?.(err)
		return {
			success: false,
			response: new Response(JSON.stringify({ error: { message: "Invalid response headers" } }), {
				status: 502,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			}),
		}
	}

	// When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
	// page), piping it through the SSE transform stream causes Next.js
	// "failed to pipe response" and crashes the chat router. Read the body,
	// pull a short human-readable message from the <title>, sanitize it, and
	// return a clean JSON error instead. The message is stripped of HTML tags
	// and clamped so untrusted upstream text never reaches the client verbatim
	// (the UI may render error.message as HTML).
	const upstreamContentType = (providerResponse.headers.get("content-type") || "").toLowerCase()
	if (
		upstreamContentType &&
		!upstreamContentType.includes("text/event-stream") &&
		!upstreamContentType.includes("application/json")
	) {
		const bodyText = await providerResponse.text().catch(() => "")
		const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i)
		const sanitizedTitle = (titleMatch?.[1] || "")
			.replace(/<[^>]*>/g, "")
			.replace(/[\r\n]+/g, " ")
			.trim()
			.slice(0, 160)
		const shortMsg =
			sanitizedTitle ||
			(bodyText.length < 200
				? bodyText
						.replace(/<[^>]*>/g, "")
						.trim()
						.slice(0, 160)
				: `Upstream returned non-SSE response (${upstreamContentType})`)
		const status = providerResponse.status || 502
		if (log?.errorLine)
			log.errorLine(
				reqTag,
				"✗",
				`BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`,
			)
		else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`)
		streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`))
		return {
			success: false,
			response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
				status,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			}),
		}
	}

	// The name the client called is the only one it is allowed to see.
	const aliasModel = calledModelName(requestedModel, model)
	// Apply the provider-neutral text-tool repair before format translation.
	// OpenAI-shaped upstream responses can emit model-native DSML in content. Kiro
	// is included because its executor normalizes EventStream frames to the same
	// OpenAI chunk shape before this response enters the translator. Run the
	// provider-neutral bridge before any Kiro/Anthropic translation so markup cannot
	// become visible assistant prose.
	let responseForStreaming = providerResponse
	if (
		(targetFormat === FORMATS.OPENAI || targetFormat === FORMATS.KIRO) &&
		((Array.isArray(body?.tools) && body.tools.length > 0) ||
			(Array.isArray(body?.functions) && body.functions.length > 0))
	) {
		responseForStreaming = bridgeTextToolCalls(
			{ response: providerResponse },
			body,
			`auto-${Date.now().toString(36)}`,
		).response
	}

	const transformStream = buildTransformStream({
		provider,
		sourceFormat,
		targetFormat,
		userAgent,
		reqLogger,
		toolNameMap,
		customToolNames,
		model,
		connectionId,
		body,
		onStreamComplete,
		apiKey,
		credentials,
		aliasModel,
	})

	// Terminal bytes when the stream aborts after HTTP 200 was already sent, so the
	// client sees a real error instead of a silently truncated stream.
	// Responses passthrough keeps its own response.failed shape; every other client
	// format gets the OpenAI error frame + [DONE], or `event: error` for Claude.
	const isResponsesPassthrough =
		sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES
	const onAbortTerminal = isResponsesPassthrough
		? buildAbortedResponsesTerminalBytes
		: (message) =>
				buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, sanitizeErrorMessage(message), sourceFormat)
	const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS

	let transformedBody
	try {
		transformedBody = pipeWithDisconnect(
			responseForStreaming,
			transformStream,
			streamController,
			onAbortTerminal,
			stallTimeoutMs,
		)
	} catch (error) {
		const safeMsg = sanitizeErrorMessage(error?.message || "Stream processing failed")
		console.error(`[STREAM] pipeWithDisconnect error: ${safeMsg}`)
		streamController?.handleError?.(error)
		return {
			success: false,
			response: new Response(JSON.stringify({ error: { message: safeMsg } }), {
				status: 502,
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			}),
		}
	}

	saveRequestDetail(
		buildRequestDetail(
			{
				provider,
				model,
				connectionId,
				requestedModel,
				latency: { ttft: 0, total: Date.now() - requestStartTime },
				tokens: { prompt_tokens: 0, completion_tokens: 0 },
				request: extractRequestConfig(body, stream),
				providerRequest: finalBody || translatedBody || null,
				providerResponse: "[Streaming - raw response not captured]",
				response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
				pxpipe,
				status: "success",
			},
			{ id: streamDetailId },
		),
	).catch((err) => {
		console.error("[RequestDetail] Failed to save streaming request:", err.message)
	})

	return {
		success: true,
		response: new Response(
			// Tee the client-bound bytes into the prompt cache. `transformedBody` is already in
			// the client's format, so a replay needs no translation.
			tapStreamForCache(transformedBody, { body, model, provider }),
			{
				headers: { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) },
			},
		),
	}
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */

import { buildOnStreamComplete } from "./streamingHelpers.ts"

export { buildOnStreamComplete } from "./streamingHelpers.ts"
