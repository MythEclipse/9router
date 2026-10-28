import { saveRequestDetail } from "@/lib/usageDb"
import { PROVIDERS } from "../../config/providers.ts"
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.ts"
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

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
	[FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
	[FORMATS.CLAUDE]: FORMATS.CLAUDE,
	[FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
	[FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
	[FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
}

// Maximum length for upstream error messages (prevent information leakage)
const MAX_ERROR_MESSAGE_LENGTH = 500

/**
 * Sanitize upstream error message to prevent information leakage
 * @param {string} message - Raw error message
 * @returns {string} Sanitized error message
 */
function sanitizeErrorMessage(message) {
	if (!message || typeof message !== "string") return "Upstream error"

	// Truncate to prevent DoS via extremely long error messages
	let sanitized = message.slice(0, MAX_ERROR_MESSAGE_LENGTH)

	// Redact potential sensitive patterns (API keys, tokens, paths)
	sanitized = sanitized
		.replace(/(?:sk|pk)_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
		.replace(/(?:api[_-]?key|token|secret)[=:\s]+[^\s"']+/gi, "$1=[REDACTED]")
		.replace(/\/home\/[^/]+/g, "/home/[USER]")
		.replace(/C:\\Users\\[^\\]+/gi, "C:\\Users\\[USER]")

	return sanitized
}

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({
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
}) {
	const isDroidCLI =
		userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli")
	// Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
	const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES
	const needsCodexTranslation =
		isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI

	if (needsCodexTranslation) {
		const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI
		return createSSETransformStreamWithLogger(
			FORMATS.OPENAI_RESPONSES,
			codexTarget,
			provider,
			reqLogger,
			toolNameMap,
			model,
			connectionId,
			body,
			onStreamComplete,
			apiKey,
			customToolNames,
			credentials,
			aliasModel,
		)
	}

	if (needsTranslation(targetFormat, sourceFormat)) {
		return createSSETransformStreamWithLogger(
			targetFormat,
			sourceFormat,
			provider,
			reqLogger,
			toolNameMap,
			model,
			connectionId,
			body,
			onStreamComplete,
			apiKey,
			customToolNames,
			credentials,
			aliasModel,
		)
	}

	return createPassthroughStreamWithLogger(
		provider,
		reqLogger,
		model,
		connectionId,
		body,
		onStreamComplete,
		apiKey,
		toolNameMap,
		aliasModel,
	)
}

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
			providerResponse,
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
		response: new Response(transformedBody, {
			headers: { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) },
		}),
	}
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({
	provider,
	model,
	connectionId,
	apiKey,
	requestedModel,
	requestStartTime,
	body,
	stream,
	finalBody,
	translatedBody,
	clientRawRequest,
	pxpipe,
	reqTag,
	log,
	modelMultipliers = null,
	isAntiProbe = false,
}) {
	const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

	const onStreamComplete = (contentObj, usage, ttftAt) => {
		let finalUsage = usage
		if (modelMultipliers && finalUsage) {
			finalUsage = applyUsageMultipliers(finalUsage, modelMultipliers)
		}
		const latency = {
			ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
			total: Date.now() - requestStartTime,
		}
		const safeContent = contentObj?.content || "[Empty streaming response]"
		const safeThinking = contentObj?.thinking || null

		saveRequestDetail(
			buildRequestDetail(
				{
					provider,
					model,
					connectionId,
					requestedModel,
					latency,
					tokens: finalUsage || { prompt_tokens: 0, completion_tokens: 0 },
					request: extractRequestConfig(body, stream),
					providerRequest: finalBody || translatedBody || null,
					providerResponse: safeContent,
					response: { content: safeContent, thinking: safeThinking, type: "streaming" },
					pxpipe,
					status: "success",
				},
				{ id: streamDetailId },
			),
		).catch((err) => {
			console.error("[RequestDetail] Failed to update streaming content:", err.message)
		})

		// Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
		saveUsageStats({
			provider,
			model,
			tokens: finalUsage,
			connectionId,
			apiKey,
			requestedModel,
			endpoint: clientRawRequest?.endpoint,
			label: "STREAM USAGE",
			silent: true,
		})
		if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage: finalUsage, latency }))
	}

	return { onStreamComplete, streamDetailId }
}
