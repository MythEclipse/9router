/** chatCore body preparation. */

import { appendRequestLog, trackPendingRequest } from "@/lib/usageDb"
import { supportsGrokCliReasoningEffort } from "../config/grokCli.ts"
import { getModelType } from "../config/providerModels.ts"
import { PROVIDERS } from "../config/providers.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { getExecutor } from "../executors/index.ts"
import { stripUnsupportedModalities } from "../translator/concerns/modality.ts"
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
import { extractTextContent } from "../translator/formats/gemini.ts"
import { FORMATS } from "../translator/formats.ts"
import { translateRequest } from "../translator/index.ts"
import { createErrorResult } from "../utils/error.ts"
import { createStreamController } from "../utils/streamHandler.ts"
import { dedupeTools } from "../utils/toolDeduper.ts"
import { applyTokenSavers } from "./chatCore/tokenSavers.ts"
import { countOf, stripContinuityFields } from "./chatCore-helpers.ts"

export async function prepareChatBody(ctx) {
	const { body } = ctx
	const {
		passthrough,
		clientTool,
		provider,
		upstreamModel,
		stream,
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
	} = ctx
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
			return {
				error: createErrorResult(
					HTTP_STATUS.BAD_REQUEST,
					`Failed to translate request for ${sourceFormat} → ${targetFormat}`,
				),
			}
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
		const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, {
			clientTool,
			model,
			messages: translatedBody.messages,
		})
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
	return {
		translatedBody,
		toolNameMap,
		customToolNames,
		finalFormat,
		pxpipeSummary,
		executor,
		streamController,
		proxyOptions,
	}
}
