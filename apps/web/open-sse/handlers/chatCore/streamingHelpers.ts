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
export function sanitizeErrorMessage(message) {
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
export function buildTransformStream({
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
			// The one place that knows both ends of the stream, so the one place that can
			// record how long it took.
			latency,
		})
		if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage: finalUsage, latency }))
	}

	return { onStreamComplete, streamDetailId }
}
