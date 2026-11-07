import type { CustomPluginResult } from "@/lib/plugins/customPluginsRuntime"
import { applyCustomPlugins } from "@/lib/plugins/customPluginsRuntime"
import { appendRequestLog, trackPendingRequest } from "@/lib/usageDb"
import { supportsGrokCliReasoningEffort } from "../config/grokCli.ts"
import {
	getModelStrip,
	getModelSupportedFormats,
	getModelTargetFormat,
	getModelType,
	getModelUpstreamId,
	PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.ts"
import { PROVIDERS } from "../config/providers.ts"
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.ts"
import { getExecutor } from "../executors/index.ts"
import { getCapabilitiesForModel } from "../providers/capabilities.ts"
import { compressMessages, formatRtkLog } from "../rtk/index.ts"
import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.ts"
import {
	isChatCompletionBody,
	isEventStreamResponse,
	jsonResponseFromBody,
	looksLikeSseText,
	readJsonBody,
	sseResponseFromCompletion,
} from "../transformer/jsonToStreamConverter.ts"
import { stripUnsupportedModalities } from "../translator/concerns/modality.ts"
import { prefetchRemoteImages } from "../translator/concerns/prefetch.ts"
import {
	applyThinking,
	extractThinking,
	stripThinkingSuffix,
} from "../translator/concerns/thinkingUnified.ts"
import {
	defaultClaudeToolType,
	shouldDefaultClaudeToolType,
} from "../translator/concerns/toolCall.ts"
import { repair as repairToolPayload } from "../translator/concerns/toolCallFallback.ts"
import { rescueRequest } from "../translator/concerns/toolCallRescue.ts"
import { anchorClaudeCache, normalizeClaudePassthrough } from "../translator/formats/claude.ts"
import { cacheConfigFrom } from "../translator/formats/claudeCache.ts"
import { FORMATS } from "../translator/formats.ts"
import { translateRequest } from "../translator/index.ts"
import { handleBypassRequest } from "../utils/bypassHandler.ts"
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.ts"
import { createErrorResult } from "../utils/error.ts"
import { createRequestLogger } from "../utils/requestLogger.ts"
import { resolveSessionId } from "../utils/sessionManager.ts"
import { createStreamController } from "../utils/streamHandler.ts"
import { prefersStreaming } from "../utils/streamPreference.ts"
import { dedupeTools } from "../utils/toolDeduper.ts"
import { dispatchExecutor } from "./chatCore/executorDispatch.ts"
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.ts"
import {
	type ChatCoreOptions,
	type ChatCoreResult,
	normalizeChatCoreOptions,
} from "./chatCore/options.ts"
import { semanticCacheGate } from "./chatCore/semanticCacheGate.ts"
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.ts"
import { buildOnStreamComplete, handleStreamingResponse } from "./chatCore/streamingHandler.ts"
import { applyTokenSavers } from "./chatCore/tokenSavers.ts"

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
	if (!body || !Array.isArray(body.messages)) return body
	for (const msg of body.messages) {
		if (msg && typeof msg === "object") {
			delete msg.encrypted_content
			delete msg.reasoning_encrypted_content
		}
	}
	return body
}

async function logInvalidCodexUpstream({
	provider,
	model,
	providerResponse,
	rawText,
	statusCode,
	reqTag,
	log,
}) {
	if (provider !== "codex") return
	const contentType = providerResponse?.headers?.get?.("content-type") || "unknown"
	const text = String(rawText || "")
		.replace(/\s+/g, " ")
		.trim()
	const snippet = text ? text.slice(0, 1200) : "<empty>"
	const msg = `codex upstream invalid JSON | status=${statusCode} | content-type=${contentType} | snippet=${snippet}`
	console.error(`[${reqTag || "codex"}] ${msg}`)
	log?.errorLine?.(
		reqTag,
		"✗",
		`UPSTREAM BAD_GATEWAY · ${provider}/${model} · invalid JSON response\n    status=${statusCode}\n    content-type=${contentType}\n    snippet=${snippet}`,
	)
}

/** Length of a request-side array field without committing to its element type. */
function countOf(value: unknown): number {
	return Array.isArray(value) ? value.length : 0
}

export async function handleChatCore(options: ChatCoreOptions): Promise<ChatCoreResult> {
	// Groups are folded with the flat legacy fields here, so every existing caller
	// (route layer, tests, standalone open-sse users) keeps sending what it always
	// sent while new callers can pass `tokenSavers` / `semanticCache` / `stream` /
	// `client` / `hooks`.
	const normalized = normalizeChatCoreOptions(options)
	// `body` is reassigned below when provider-level thinking config is injected.
	let { body } = normalized
	const { modelInfo, credentials, log, tokenSavers, semanticCache, client, hooks } = normalized
	const { stream: streamConfig } = normalized
	const {
		connectionId,
		userAgent,
		apiKey,
		clientRawRequest,
		ccFilterNaming,
		requestedModel,
		providerThinking,
		providerOverrides,
		modelMultipliers = null,
		isAntiProbe = false,
		hideError = false,
		sourceFormatOverride,
		toolCallFallbackEnabled = true,
	} = client
	const { onCredentialsRefreshed, onRequestSuccess, onDisconnect } = hooks
	const { clientSignal = null } = streamConfig
	const { provider, model } = modelInfo
	const requestStartTime = Date.now()
	// Stable per-session color so all lines of one CLI conversation share a tag
	const sessionSeed = (() => {
		try {
			return resolveSessionId({
				headers: clientRawRequest?.headers,
				body,
				connectionId,
				scope: provider,
			})
		} catch {
			return connectionId || ""
		}
	})()
	const reqTag = log?.tagForSession
		? log.tagForSession(sessionSeed)
		: log?.nextTag
			? log.nextTag()
			: ""
	// The live request list has to show the model that was called, never the one it mapped to.
	const trackedModel = requestedModel || model

	const sourceFormat = sourceFormatOverride || detectFormat(body)

	// Check for bypass patterns (warmup, skip, cc naming)
	const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming)
	// handleBypassRequest answers with a bare Response, which is what this path has
	// always handed back (typed away here rather than reshaped at runtime).
	if (bypassResponse) return bypassResponse as unknown as ChatCoreResult

	// Semantic / duplicate prompt cache (non-streaming and streamed hits).
	const cachedResult = semanticCacheGate({
		...semanticCache,
		body,
		provider,
		model,
		requestedModel,
		connectionId,
		apiKey,
		clientRawRequest,
		log,
	})
	if (cachedResult) return cachedResult

	const alias = PROVIDER_ID_TO_ALIAS[provider] || provider
	const modelTargetFormat = getModelTargetFormat(alias, model)
	// Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
	// Per-model guard: only use the transport when the model declares support for that
	// sourceFormat - opencode-go models differ in endpoint support (kimi/glm only do
	// /chat/completions), so without this guard a claude-format request would wrongly
	// route kimi to /messages.
	const modelSupportedFormats = getModelSupportedFormats(alias, model)
	const runtimeTransport = resolveTransport(provider, sourceFormat)
	// Per-model guard: when a model declares supportedFormats, only use the
	// sourceFormat-matched transport if that format is declared (opencode-go models
	// differ - kimi/glm only do /chat/completions). Undeclared models keep the
	// upstream default (use the transport), preserving behavior for glm/deepseek/...
	// When the client's wire format is NOT among the model's supportedFormats, fall
	// back to the transport for the model's declared targetFormat so the URL always
	// matches the translated body. Without this, a Responses-only model (e.g. Muse
	// Spark: supportedFormats ["openai-responses"]) requested by an OpenAI client is
	// translated to the Responses body (`input`) yet POSTed to the default Chat
	// Completions URL, and upstream rejects it: "unknown parameter `input`".
	const modelTargetTransport = modelTargetFormat
		? resolveTransport(provider, modelTargetFormat)
		: null
	const useTransport =
		!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat)
			? runtimeTransport
			: modelTargetTransport
	// A source-format-matched endpoint keeps the request lossless. Prefer it
	// over a model-level targetFormat, which is only the fallback for clients
	// whose wire format has no supported transport (for example MiniMax-M3:
	// OpenAI clients should stay on /chat/completions; other clients can fall
	// back to its declared Claude target).
	const targetFormat =
		useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials)
	if (useTransport && credentials) credentials.runtimeTransport = useTransport
	const stripList = getModelStrip(alias, model)

	// Inject provider-level thinking config override (only if client hasn't set)
	// on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
	if (providerThinking?.mode && providerThinking.mode !== "auto") {
		const mode = providerThinking.mode
		if (mode === "on" && !body.thinking) {
			console.log("Injecting provider-level thinking config override: on")
			body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } }
		} else if (mode === "off" && !body.thinking) {
			body = { ...body, thinking: { type: "disabled" } }
		} else if (!body.reasoning_effort) {
			body = { ...body, reasoning_effort: mode }
		}
	}

	const upstreamModel = getModelUpstreamId(alias, model, body)

	// Per-request opt-out: client can bypass all token savers via header
	const tokenSaverEnabled = clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() !== "off"

	// Cursor's translator rewrites tool_result into user text, so RTK must run on
	// the source body before translation. Every other pair translates the tool
	// shapes 1:1 - keep the post-translate pass there so those providers are
	// untouched (and a retry never re-compresses an already-compressed body).
	const preTranslateRtk =
		provider === "cursor" ? compressMessages(body, tokenSaverEnabled && tokenSavers.rtkEnabled) : null
	const preTranslateRtkLine = formatRtkLog(preTranslateRtk)
	if (preTranslateRtkLine) console.log(preTranslateRtkLine)

	const clientRequestedStreaming =
		body.stream === true ||
		sourceFormat === FORMATS.ANTIGRAVITY ||
		sourceFormat === FORMATS.GEMINI ||
		sourceFormat === FORMATS.GEMINI_CLI
	const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true
	let stream = providerRequiresStreaming ? true : prefersStreaming(sourceFormat, body)

	// Image generation models require non-streaming (Google v1internal:generateContent)
	const modelType = getModelType(alias, model)
	const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model)
	if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
		stream = false
	}

	// DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
	// Non-interactive mode (-p flag) sends without stream and can't parse SSE.
	// Only force non-streaming when client didn't explicitly request it.
	const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body)
	if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false

	// Check client Accept header preference for non-streaming requests
	// This fixes AI SDK compatibility where clients send Accept: application/json
	const acceptHeader = clientRawRequest?.headers?.accept || ""
	const clientPrefersJson = acceptHeader.includes("application/json")
	const clientPrefersSSE = acceptHeader.includes("text/event-stream")
	if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
		stream = false
	}

	const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model)
	if (clientRawRequest)
		reqLogger.logClientRawRequest(
			clientRawRequest.endpoint,
			clientRawRequest.body,
			clientRawRequest.headers,
		)
	reqLogger.logRawRequest(body)
	log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`)

	// Native passthrough: CLI tool and provider are the same ecosystem
	// Skip all translation/normalization - only model and Bearer are swapped
	const clientTool = detectClientTool(clientRawRequest?.headers || {}, body)
	const passthrough = isNativePassthrough(clientTool, provider)

	// Expose raw client headers to translators/executors for session-id resolution
	if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {}

	// Execute every enabled custom plugin for the target model
	let pluginResult: CustomPluginResult = {
		isVisionActive: false,
		isThinkDeeperActive: false,
		isSpeedModeActive: false,
	}
	try {
		pluginResult = await applyCustomPlugins(body, provider, model, sourceFormat, requestedModel)
	} catch (err) {
		log?.warn?.("PLUGIN", `Custom plugin error: ${err.message}`)
	}

	if (pluginResult.contextStats?.reason === "trimmed") {
		log?.debug?.(
			"PLUGIN",
			`Context Squeezer dropped ${pluginResult.contextStats.droppedTurns} turn(s): ${pluginResult.contextStats.tokensBefore} -> ${pluginResult.contextStats.tokensAfter} tokens`,
		)
	}

	// Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
	if (!passthrough) {
		const caps = getCapabilitiesForModel(provider, model)
		if (pluginResult.isVisionActive) caps.vision = true
		if (pluginResult.isThinkDeeperActive) caps.reasoning = true
		if (stripUnsupportedModalities(body, sourceFormat, caps)) {
			log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`)
		}
		// Convert remote image URLs to base64 for targets that can't fetch URLs.
		try {
			const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: undefined })
			if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`)
		} catch (e) {
			log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`)
		}
	}

	let translatedBody
	let toolNameMap
	let customToolNames
	if (passthrough) {
		log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`)
		translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) }
		if (provider === "codex") {
			const suffixThinking: Record<string, unknown> = {}
			applyThinking(sourceFormat, upstreamModel, suffixThinking, provider)
			if (suffixThinking.reasoning_effort) {
				const reasoning = translatedBody.reasoning
				translatedBody.reasoning = {
					...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
					effort: suffixThinking.reasoning_effort,
				}
				delete translatedBody.reasoning_effort
			}
		}
		// Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
		if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model)
	} else {
		translatedBody = translateRequest(
			sourceFormat,
			targetFormat,
			upstreamModel,
			body,
			stream,
			credentials,
			provider,
			reqLogger,
			stripList,
			connectionId,
			clientTool,
		)
		if (!translatedBody) {
			trackPendingRequest(trackedModel, provider, connectionId, false, true)
			return createErrorResult(
				HTTP_STATUS.BAD_REQUEST,
				`Failed to translate request for ${sourceFormat} → ${targetFormat}`,
			)
		}
		toolNameMap = translatedBody._toolNameMap
		delete translatedBody._toolNameMap
		customToolNames = translatedBody._customToolNames
		delete translatedBody._customToolNames
		translatedBody.model = stripThinkingSuffix(upstreamModel)
		stripContinuityFields(translatedBody)
	}

	// Tool normalization: MCP-equivalent built-in dedup (Claude clients) + same-name
	// dedup for DeepSeek models (upstream rejects duplicate tool names on all endpoints).
	if (Array.isArray(translatedBody.tools)) {
		const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, { clientTool, model })
		if (stripped.length > 0) {
			translatedBody.tools = deduped
			log?.debug?.(
				"TOOLDEDUP",
				`stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`,
			)
		}
	}

	// Token savers: applied at the final body just before dispatch
	// Covers both passthrough (source shape) and translated (target shape) flows
	const finalFormat = passthrough ? sourceFormat : targetFormat

	// Request line: one correlated summary (fmt + thinking + counts + account)
	if (log?.line) {
		const clientModel =
			(clientRawRequest?.body?.model as string | undefined) || `${provider}/${model}`
		const msgN =
			countOf(translatedBody.messages) ||
			countOf(translatedBody.input) ||
			countOf(translatedBody.contents) ||
			countOf(body.messages) ||
			countOf(body.input) ||
			0
		const toolN = countOf(translatedBody.tools) || countOf(body.tools) || 0
		const fmtStr = passthrough
			? `FMT: ${sourceFormat} (passthrough)`
			: `FMT: ${sourceFormat}→${targetFormat}`
		const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model)
		const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null
		const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-"
		const parts = [
			`POST ${clientModel} → ${provider}/${model}`,
			fmtStr,
			stream ? "STREAM" : "JSON",
			`${msgN} MSG`,
		]
		if (toolN) parts.push(`${toolN} TOOL`)
		if (think) parts.push(`THINK:${think}`)
		parts.push(`ACC:${acc}`)
		log.line(reqTag, "▶", parts.join(" · "))
	}

	// TTS models don't support tool messages/function calling
	if (getModelType(alias, model) === "tts" && translatedBody.messages) {
		translatedBody.messages = translatedBody.messages.filter((msg) => msg.role !== "tool")
		delete translatedBody.tools
	}

	// Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
	// reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
	// Provider-scoped via quirks (shouldDefaultClaudeToolType): only gateways that declare
	// requireClaudeToolType get the explicit type. Applying it unconditionally breaks
	// Claude-format endpoints that only accept the legacy typeless tool shape - DeepSeek's
	// Anthropic-compatible endpoint 400s with "unknown variant `custom`" (#3905).
	if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
		translatedBody.tools = defaultClaudeToolType(translatedBody.tools)
	}

	// Repair malformed tool payloads before dispatch: truncated JSON arguments, tool
	// results nothing asked for, a tool_choice naming a tool that is not in the array.
	// Any of those is a deterministic 400, and inside a combo it would burn every
	// member before the first one could answer. Fail-open - unchanged body on error.
	if (
		toolCallFallbackEnabled &&
		Array.isArray(translatedBody.tools) &&
		translatedBody.tools.length > 0
	) {
		repairToolPayload(translatedBody, finalFormat)
		// A call the client already rejected stays in the history it sends back on
		// the next turn, so repairing only the outbound body leaves the same broken
		// call being re-validated and rejected every turn after. Renaming it back to
		// the case the request declared and filling the arguments it lost is what
		// lets the turn continue.
		const rescued = rescueRequest(translatedBody)
		if (rescued.renamed || rescued.recovered || rescued.dropped) {
			log?.debug?.(
				"TOOLRESCUE",
				`${rescued.renamed} renamed, ${rescued.recovered} recovered, ${rescued.dropped} dropped (history)`,
			)
		}
	}

	// Token-saver flags accumulator for the single "⚙" log line below.
	const xf = []

	// Token savers: applied at the final body just before dispatch. Each saver
	// pushes its flag into `xf`; Headroom logs its own info/warn lines inside,
	// and the single "⚙" line stays here so it still prints after every saver.
	const savers = await applyTokenSavers(translatedBody, finalFormat, tokenSavers, {
		provider,
		model,
		upstreamModel,
		finalFormat,
		tokenSaverEnabled,
		preTranslateRtk,
		log,
		flags: xf,
	})
	translatedBody = savers.translatedBody
	const pxpipeSummary = savers.pxpipeSummary

	if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "))

	// Pin cache breakpoints to the final body - every saver above can reshape
	// system/tools/messages, and a stale anchor costs a full prefix rewrite.
	if (passthrough && clientTool === "claude")
		anchorClaudeCache(translatedBody, cacheConfigFrom(providerOverrides))

	const executor = getExecutor(provider)
	trackPendingRequest(trackedModel, provider, connectionId, true)
	appendRequestLog({
		model: trackedModel,
		provider,
		connectionId,
		status: "PENDING",
		requestedModel: model,
	}).catch(() => {})

	const msgCount =
		countOf(translatedBody.messages) ||
		countOf(translatedBody.input) ||
		countOf(translatedBody.contents) ||
		countOf(translatedBody.request?.contents) ||
		0
	log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`)

	const streamController = createStreamController({
		onDisconnect: (reason) => {
			trackPendingRequest(trackedModel, provider, connectionId, false)
			if (onDisconnect) onDisconnect(reason)
		},
		onError: () => trackPendingRequest(trackedModel, provider, connectionId, false),
		log,
		provider,
		model,
		reqTag,
	})

	const handleClientAbort = () => {
		if (clientSignal?.aborted) {
			streamController.handleDisconnect("client_closed")
			streamController.abort()
		}
	}
	if (clientSignal) {
		if (clientSignal.aborted) handleClientAbort()
		else clientSignal.addEventListener("abort", handleClientAbort, { once: true })
	}

	const proxyOptions = {
		connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
		connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
		connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
		proxyType: credentials?.providerSpecificData?.proxyType || "",
		relayUrl: credentials?.providerSpecificData?.relayUrl || "",
		vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
		// Strict pools must never silently fall back to a direct connection —
		// honored on the Cursor AgentService h2 path and in proxyFetch (#4333).
		proxyPoolId: credentials?.providerSpecificData?.connectionProxyPoolId || null,
		strictProxy: credentials?.providerSpecificData?.strictProxy === true,
	}

	if (proxyOptions.relayUrl || proxyOptions.vercelRelayUrl) {
		const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown"
		const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none"
		log?.info?.(
			"PROXY",
			`${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | type=${proxyOptions.proxyType || "relay"} | relay=${proxyOptions.relayUrl || proxyOptions.vercelRelayUrl}`,
		)
	} else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
		let maskedProxyUrl = proxyOptions.connectionProxyUrl
		try {
			const parsed = new URL(proxyOptions.connectionProxyUrl)
			const host = parsed.hostname || ""
			const port = parsed.port ? `:${parsed.port}` : ""
			const protocol = parsed.protocol || "http:"
			maskedProxyUrl = `${protocol}//${host}${port}`
		} catch {
			// Keep raw if URL parsing fails
		}

		const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none"
		const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown"
		log?.info?.(
			"PROXY",
			`${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`,
		)
	}

	if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
		const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown"
		log?.debug?.(
			"PROXY",
			`${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`,
		)
	}

	// Execute request, then retry after a token refresh / malformed body and
	// degrade the tool payload if the upstream rejects it. Everything that
	// reports a dispatch failure as a Result happens in there.
	const dispatched = await dispatchExecutor({
		executor,
		provider,
		model,
		trackedModel,
		translatedBody,
		stream,
		credentials,
		sessionSeed,
		clientTool,
		proxyOptions,
		providerOverrides,
		targetFormat,
		reqLogger,
		reqTag,
		log,
		requestStartTime,
		connectionId,
		requestedModel,
		apiKey,
		clientRawRequest,
		body,
		pxpipeSummary,
		toolCallFallbackEnabled,
		toolNameMap,
		clientRequestedStreaming,
		onCredentialsRefreshed,
		streamController,
		hideError,
	})
	if (dispatched.kind === "return") return dispatched.result as ChatCoreResult
	let { providerResponse } = dispatched
	let { providerResponseFormat } = dispatched
	// Written by the executor, never reassigned: safe as a const.
	const { finalBody } = dispatched
	const { toolNameMap: resolvedToolNameMap } = dispatched
	toolNameMap = resolvedToolNameMap

	const sharedCtx = {
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
		pxpipe: pxpipeSummary,
		reqTag,
		log,
		pluginResult,
		modelMultipliers,
		isAntiProbe,
	}
	const appendLog = (extra) =>
		appendRequestLog({
			model: trackedModel,
			provider,
			connectionId,
			requestedModel: model,
			...extra,
		}).catch(() => {})
	const trackDone = () => trackPendingRequest(trackedModel, provider, connectionId, false)

	// Upstream shape mismatch: a provider can answer with a finished JSON document
	// even though we asked it to stream (it ignores the flag, or the client omitted
	// `stream` so the flag never left). Piping that body through the SSE parser
	// emits zero frames - the client hangs on an empty stream and usage bills 0
	// tokens - so branch on what actually arrived, not on what we asked for.
	const rawUpstreamText =
		providerResponse && typeof providerResponse.clone === "function"
			? await providerResponse
					.clone()
					.text()
					.catch(() => "")
			: ""
	if (stream && !isEventStreamResponse(providerResponse) && !looksLikeSseText(rawUpstreamText)) {
		const mismatchedBody = await readJsonBody(providerResponse)
		if (mismatchedBody === null) {
			// Nothing readable came back and the client never asked for a stream, so it
			// gets a clean gateway error instead of a response with no body to parse.
			if (!clientRequestedStreaming) {
				await logInvalidCodexUpstream({
					provider,
					model,
					providerResponse,
					rawText: rawUpstreamText,
					statusCode: providerResponse?.status || HTTP_STATUS.BAD_GATEWAY,
					reqTag,
					log,
				})
				appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` })
				streamController.handleComplete()
				return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`)
			}
		} else if (clientRequestedStreaming && isChatCompletionBody(mismatchedBody)) {
			// A streaming client gets the completion replayed as chunks, which the
			// normal pipeline then reshapes into its own format.
			providerResponse = sseResponseFromCompletion(mismatchedBody, providerResponse)
			providerResponseFormat = FORMATS.OPENAI
		} else {
			const result = await handleNonStreamingResponse({
				...sharedCtx,
				stream: clientRequestedStreaming,
				providerResponse: jsonResponseFromBody(mismatchedBody, providerResponse),
				sourceFormat,
				targetFormat: providerResponseFormat,
				reqLogger,
				toolNameMap,
				customToolNames,
				trackDone,
				appendLog,
			})
			streamController.handleComplete()
			return result as ChatCoreResult
		}
	}

	// Provider forced streaming but client wants JSON. The Responses wire always
	// streams upstream (openaiToOpenAIResponsesRequest pins stream:true), so a
	// non-stream OpenAI/native client behind a Responses upstream must also take
	// this path — handleForcedSSEToJson returns null when the body is not SSE.
	if (
		!clientRequestedStreaming &&
		(providerRequiresStreaming || providerResponseFormat === FORMATS.OPENAI_RESPONSES)
	) {
		const result = await handleForcedSSEToJson({
			...sharedCtx,
			providerResponse,
			sourceFormat,
			targetFormat: providerResponseFormat,
			customToolNames,
			toolNameMap,
			trackDone,
			appendLog,
		})
		if (result) {
			streamController.handleComplete()
			return result as ChatCoreResult
		}
	}

	// True non-streaming response
	if (!stream) {
		const result = await handleNonStreamingResponse({
			...sharedCtx,
			providerResponse,
			sourceFormat,
			targetFormat: providerResponseFormat,
			reqLogger,
			toolNameMap,
			customToolNames,
			trackDone,
			appendLog,
		})
		streamController.handleComplete()
		return result as ChatCoreResult
	}

	// Streaming response
	const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx })
	return handleStreamingResponse({
		...sharedCtx,
		providerResponse,
		sourceFormat,
		targetFormat: providerResponseFormat,
		userAgent,
		reqLogger,
		toolNameMap,
		customToolNames,
		streamController,
		onStreamComplete,
		streamDetailId,
		credentials,
	}) as Promise<ChatCoreResult>
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
	if (!expiresAt) return false
	return new Date(expiresAt).getTime() - Date.now() < bufferMs
}
