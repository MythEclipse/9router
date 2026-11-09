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
import { prepareChatBody } from "./chatCore-body.ts"
import { prepareChatCoreContext } from "./chatCore-context.ts"
import {
	countOf,
	isTokenExpiringSoon,
	logInvalidCodexUpstream,
	stripContinuityFields,
} from "./chatCore-helpers.ts"
import { respondFromUpstream } from "./chatCore-respond.ts"

export { isTokenExpiringSoon, stripContinuityFields } from "./chatCore-helpers.ts"

export async function handleChatCore(options: ChatCoreOptions): Promise<ChatCoreResult> {
	// Groups are folded with the flat legacy fields here, so every existing caller
	// (route layer, tests, standalone open-sse users) keeps sending what it always
	// sent while new callers can pass `tokenSavers` / `semanticCache` / `stream` /
	// `client` / `hooks`.
	const ctx: Awaited<ReturnType<typeof prepareChatCoreContext>> =
		await prepareChatCoreContext(options)
	if ((ctx as { early?: unknown }).early) return (ctx as { early: ChatCoreResult }).early
	const { body, stream } = ctx as unknown as { body: Record<string, unknown>; stream: boolean }
	const {
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
		providerOverrides,
		modelMultipliers,
		isAntiProbe,
		hideError,
		sourceFormatOverride,
		toolCallFallbackEnabled,
	} = ctx as unknown as Record<string, any>
	const { onCredentialsRefreshed, onRequestSuccess, onDisconnect } = hooks
	const { clientSignal = null } = streamConfig
	const { provider, model } = modelInfo
	const {
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
		clientTool,
		passthrough,
		pluginResult,
		reqLogger,
	} = ctx as unknown as Record<string, any>
	const prepared = await prepareChatBody({
		body,
		stream,
		passthrough,
		clientTool,
		provider,
		upstreamModel,
		credentials,
		stripList,
		connectionId,
		reqLogger,
		log,
		trackedModel,
		alias,
		model,
		tokenSaverEnabled,
		preTranslateRtk,
		tokenSavers,
		onDisconnect,
		targetFormat,
		sourceFormat,
		clientRawRequest,
		reqTag,
		toolCallFallbackEnabled,
		providerOverrides,
		clientSignal,
	})
	if ((prepared as { error?: unknown }).error) return (prepared as { error: ChatCoreResult }).error
	const {
		translatedBody,
		customToolNames,
		finalFormat,
		pxpipeSummary,
		executor,
		streamController,
		proxyOptions,
	} = prepared as unknown as Record<string, any>
	let toolNameMap: Map<string, unknown> | undefined = (prepared as unknown as Record<string, any>)
		.toolNameMap
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
	const { providerResponse } = dispatched
	const { providerResponseFormat } = dispatched
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

	return respondFromUpstream({
		providerResponse,
		providerResponseFormat,
		stream,
		clientRequestedStreaming,
		sourceFormat,
		sharedCtx,
		reqLogger,
		toolNameMap,
		customToolNames,
		trackDone,
		appendLog,
		streamController,
		providerRequiresStreaming,
		userAgent,
		credentials,
		log,
		logInvalidCodexUpstream,
	}) as Promise<ChatCoreResult>
}
