/** chatCore request context. */
import { applyCustomPlugins, type CustomPluginResult } from "@/lib/plugins/customPluginsRuntime"
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
import { TOKEN_SAVER_HEADER } from "../config/runtimeConfig.ts"
import { getCapabilitiesForModel } from "../providers/capabilities.ts"
import { compressMessages, formatRtkLog } from "../rtk/index.ts"
import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.ts"
import { stripUnsupportedModalities } from "../translator/concerns/modality.ts"
import { prefetchRemoteImages } from "../translator/concerns/prefetch.ts"
import { FORMATS } from "../translator/formats.ts"
import { handleBypassRequest } from "../utils/bypassHandler.ts"
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.ts"
import { createRequestLogger } from "../utils/requestLogger.ts"
import { resolveSessionId } from "../utils/sessionManager.ts"
import { prefersStreaming } from "../utils/streamPreference.ts"
import type { ChatCoreOptions, ChatCoreResult } from "./chatCore/options.ts"
import { normalizeChatCoreOptions } from "./chatCore/options.ts"
import { semanticCacheGate } from "./chatCore/semanticCacheGate.ts"
import { countOf } from "./chatCore-helpers.ts"

export async function prepareChatCoreContext(options: ChatCoreOptions) {
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
	if (bypassResponse) return { early: bypassResponse as unknown as ChatCoreResult }

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
	if (cachedResult) return { early: cachedResult }

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

	return {
		early: cachedResult,
		body,
		modelInfo,
		credentials,
		log,
		tokenSavers,
		semanticCache,
		client,
		hooks,
		streamConfig,
		connectionId,
		userAgent,
		apiKey,
		clientRawRequest,
		ccFilterNaming,
		requestedModel,
		providerThinking,
		providerOverrides,
		modelMultipliers,
		isAntiProbe,
		hideError,
		sourceFormatOverride,
		toolCallFallbackEnabled,
		onCredentialsRefreshed,
		onRequestSuccess,
		onDisconnect,
		clientSignal,
		provider,
		model,
		requestStartTime,
		sessionSeed,
		reqTag,
		trackedModel,
		sourceFormat,
		alias,
		targetFormat,
		stripList,
		upstreamModel,
		tokenSaverEnabled,
		preTranslateRtk,
		clientRequestedStreaming,
		providerRequiresStreaming,
		stream,
		modelType,
		detectedTool,
		reqLogger,
		clientTool,
		passthrough,
		pluginResult,
	}
}
