import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider";
import { translateRequest } from "../translator/index";
import { applyThinking, extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified";
import { FORMATS } from "../translator/formats";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude";
import { cacheConfigFrom } from "../translator/formats/claudeCache";
import { createStreamController } from "../utils/streamHandler";
import { refreshWithRetry } from "../services/tokenRefresh";
import { createRequestLogger } from "../utils/requestLogger";
import { getModelTargetFormat, getModelSupportedFormats, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels";
import { PROVIDERS } from "../config/providers";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error";
import { upstreamResponseHeaders } from "../utils/upstreamHeaders";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig";
import { handleBypassRequest } from "../utils/bypassHandler";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb";
import { getExecutor } from "../executors/index";
import { supportsGrokCliReasoningEffort } from "../config/grokCli";
import { buildRequestDetail, extractRequestConfig, saveFailedUsage } from "./chatCore/requestDetail";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler";
import {
  isEventStreamResponse,
  looksLikeSseText,
  isChatCompletionBody,
  readJsonBody,
  jsonResponseFromBody,
  sseResponseFromCompletion,
} from "../transformer/jsonToStreamConverter";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler";
import { applyModelAlias, calledModelName } from "../utils/modelAlias";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector";
import { dedupeTools } from "../utils/toolDeduper";
import { takeRenamedToolNames } from "../utils/opencodeFingerprint";
import { injectCaveman } from "../rtk/caveman";
import { injectPonytail } from "../rtk/ponytail";
import { pruneContextMessages, resolvePruningLimit } from "../rtk/contextPruning";
import { checkSemanticCache, saveToSemanticCache, setSemanticCacheTtlMs, setSemanticCacheMaxEntries } from "../rtk/semanticCache";
import { getAdapter } from "@/lib/db/driver";
import { recordTokenSavings, measurePruningSavings, measureRtkSavings, measureCacheSavings } from "../rtk/tokenSaverStats";
import { compressMessages, formatRtkLog } from "../rtk/index";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog, isHeadroomPhantomSavings } from "../rtk/headroom";
import type { HeadroomDiagnostics } from "../rtk/headroom";
import { compressWithPxpipe } from "../rtk/pxpipe";
import { getCapabilitiesForModel } from "../providers/capabilities";
import { stripUnsupportedModalities } from "../translator/concerns/modality";
import { prefetchRemoteImages } from "../translator/concerns/prefetch";
import { defaultClaudeToolType, shouldDefaultClaudeToolType } from "../translator/concerns/toolCall";
import { repair as repairToolPayload, degrade as degradeToolPayload, isToolCallRejection, TOOL_FALLBACK_MAX_LEVEL } from "../translator/concerns/toolCallFallback";
import { rescueRequest } from "../translator/concerns/toolCallRescue";
import { resolveSessionId } from "../utils/sessionManager";
import { applyCustomPlugins } from "@/lib/plugins/customPluginsRuntime";
import type { CustomPluginResult } from "@/lib/plugins/customPluginsRuntime";
import { injectCustomPrompt } from "../rtk/customPrompt";

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
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

async function logInvalidCodexUpstream({ provider, model, providerResponse, rawText, statusCode, reqTag, log }) {
  if (provider !== "codex") return;
  const contentType = providerResponse?.headers?.get?.("content-type") || "unknown";
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  const snippet = text ? text.slice(0, 1200) : "<empty>";
  const msg = `codex upstream invalid JSON | status=${statusCode} | content-type=${contentType} | snippet=${snippet}`;
  console.error(`[${reqTag || "codex"}] ${msg}`);
  log?.errorLine?.(reqTag, "✗", `UPSTREAM BAD_GATEWAY · ${provider}/${model} · invalid JSON response\n    status=${statusCode}\n    content-type=${contentType}\n    snippet=${snippet}`);
}

/**
 * Structured logger threaded through the handler. Callers pass console-like
 * objects whose optional helpers vary, hence the open index signature.
 */
interface LogSink {
  info?: (tag: string, message: string) => void;
  debug?: (tag: string, message: string) => void;
  warn?: (tag: string, message: string) => void;
  error?: (tag: string, message: string) => void;
  line?: (tag: string, icon: string, message: string) => void;
  errorLine?: (tag: string, icon: string, message: string) => void;
  fmtThink?: (thinking: unknown) => string | null;
  tagForSession?: (seed: string) => string;
  nextTag?: () => string;
  [key: string]: unknown;
}

/**
 * Every knob `handleChatCore` accepts. All fields stay optional so the many
 * call sites (routes, other handlers, tests) keep compiling as before; the
 * ones the function relies on unconditionally are marked required.
 */
interface ChatCoreOptions {
  body: Record<string, unknown> & { stream?: boolean };
  modelInfo: { provider: string; model: string };
  credentials: Record<string, unknown> & {
    connectionName?: string;
    connectionId?: string;
    runtimeTransport?: { format?: string; [key: string]: unknown };
    rawHeaders?: Record<string, string>;
    providerSpecificData?: Record<string, unknown> & {
      connectionProxyEnabled?: boolean;
      connectionProxyUrl?: string;
      connectionNoProxy?: string;
      proxyType?: string;
      relayUrl?: string;
      vercelRelayUrl?: string;
      connectionProxyPoolId?: string | null;
      strictProxy?: boolean;
    };
  };
  log?: LogSink;
  onCredentialsRefreshed?: (credentials: Record<string, unknown>) => void | Promise<void>;
  onRequestSuccess?: () => void | Promise<void>;
  onDisconnect?: (reason?: string | { reason: string; duration: number }) => void | Promise<void>;
  clientRawRequest?: { headers?: Record<string, string>; endpoint?: string; body?: Record<string, unknown>; [key: string]: unknown };
  connectionId?: string;
  userAgent?: string;
  apiKey?: string;
  ccFilterNaming?: boolean;
  rtkEnabled?: unknown;
  contextPruningEnabled?: unknown;
  maxMessagesLimit?: number;
  semanticCacheEnabled?: boolean;
  semanticCacheTtlHours?: number;
  semanticCacheMaxEntries?: number;
  contextPruningLevel?: unknown;
  headroomEnabled?: boolean;
  headroomUrl?: string;
  headroomCompressUserMessages?: boolean;
  headroomTimeoutMs?: number;
  cavemanEnabled?: unknown;
  cavemanLevel?: unknown;
  ponytailEnabled?: unknown;
  ponytailLevel?: unknown;
  pxpipeEnabled?: unknown;
  pxpipeMinChars?: unknown;
  pxpipeTimeoutMs?: number;
  pxpipeTransform?: unknown;
  onPxpipeEvent?: (event: Record<string, unknown>) => void;
  sourceFormatOverride?: string;
  providerThinking?: { mode?: string; [key: string]: unknown };
  requestedModel?: string;
  toolCallFallbackEnabled?: boolean;
  providerOverrides?: unknown;
  modelMultipliers?: unknown;
  isAntiProbe?: boolean;
  hideError?: boolean;
  customPromptEnabled?: boolean;
  customPrompt?: string;
  clientSignal?: AbortSignal | null;
}

/** Length of a request-side array field without committing to its element type. */
function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, contextPruningEnabled, maxMessagesLimit, semanticCacheEnabled, semanticCacheTtlHours, semanticCacheMaxEntries, contextPruningLevel, headroomEnabled, headroomUrl, headroomCompressUserMessages, headroomTimeoutMs, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, pxpipeEnabled, pxpipeMinChars, pxpipeTimeoutMs, pxpipeTransform, onPxpipeEvent, sourceFormatOverride, providerThinking, requestedModel, toolCallFallbackEnabled = true, providerOverrides, modelMultipliers = null, isAntiProbe = false, hideError = false, customPromptEnabled = false, customPrompt = "", clientSignal = null }: ChatCoreOptions) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");
  // The live request list has to show the model that was called, never the one it mapped to.
  const trackedModel = requestedModel || model;

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  // Check Semantic / Duplicate Prompt Cache (for non-streaming requests)
  // Cache TTL and cap come from settings so the Token Saver sliders apply
  // without a proxy restart.
  if (semanticCacheEnabled) {
    const hours = Number(semanticCacheTtlHours);
    if (Number.isFinite(hours) && hours > 0) setSemanticCacheTtlMs(hours * 60 * 60 * 1000);
    if (semanticCacheMaxEntries > 0) setSemanticCacheMaxEntries(semanticCacheMaxEntries);
  }

  if (semanticCacheEnabled && !body.stream) {
    const cachedResponse = checkSemanticCache(body, `${provider}/${model}`);
    if (cachedResponse) {
      log?.info?.("CACHE", `⚡ Instant semantic cache hit for ${provider}/${model}`);
      // A hit replays the provider's own billed usage - that is exactly what
      // the second identical request would have cost.
      recordTokenSavings(getAdapter(), { provider, model, cache: measureCacheSavings(cachedResponse) });
      // A cache hit must not name the model that originally served it either.
      applyModelAlias(cachedResponse, calledModelName(requestedModel, model));
      return {
        success: true,
      response: new Response(JSON.stringify(cachedResponse), {
          headers: { "Content-Type": "application/json", "X-9Router-Cache": "HIT" },
        }),
      };
    }
  }

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
  // Per-model guard: only use the transport when the model declares support for that
  // sourceFormat - opencode-go models differ in endpoint support (kimi/glm only do
  // /chat/completions), so without this guard a claude-format request would wrongly
  // route kimi to /messages.
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
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
  const modelTargetTransport = modelTargetFormat ? resolveTransport(provider, modelTargetFormat) : null;
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat))
    ? runtimeTransport
    : modelTargetTransport;
  // A source-format-matched endpoint keeps the request lossless. Prefer it
  // over a model-level targetFormat, which is only the fallback for clients
  // whose wire format has no supported transport (for example MiniMax-M3:
  // OpenAI clients should stay on /chat/completions; other clients can fall
  // back to its declared Claude target).
  const targetFormat = useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  const stripList = getModelStrip(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const upstreamModel = getModelUpstreamId(alias, model, body);

  // Per-request opt-out: client can bypass all token savers via header
  const tokenSaverEnabled = clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() !== "off";

  // Cursor's translator rewrites tool_result into user text, so RTK must run on
  // the source body before translation. Every other pair translates the tool
  // shapes 1:1 - keep the post-translate pass there so those providers are
  // untouched (and a retry never re-compresses an already-compressed body).
  const preTranslateRtk = provider === "cursor"
    ? compressMessages(body, tokenSaverEnabled && rtkEnabled)
    : null;
  const preTranslateRtkLine = formatRtkLog(preTranslateRtk);
  if (preTranslateRtkLine) console.log(preTranslateRtkLine);

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization - only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Execute every enabled custom plugin for the target model
  let pluginResult: CustomPluginResult = { isVisionActive: false, isThinkDeeperActive: false, isSpeedModeActive: false };
  try {
    pluginResult = await applyCustomPlugins(body, provider, model, sourceFormat, requestedModel);
  } catch (err) {
    log?.warn?.("PLUGIN", `Custom plugin error: ${err.message}`);
  }

  if (pluginResult.contextStats?.reason === "trimmed") {
    log?.debug?.("PLUGIN", `Context Squeezer dropped ${pluginResult.contextStats.droppedTurns} turn(s): ${pluginResult.contextStats.tokensBefore} -> ${pluginResult.contextStats.tokensAfter} tokens`);
  }

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (pluginResult.isVisionActive) caps.vision = true;
    if (pluginResult.isThinkDeeperActive) caps.reasoning = true;
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: undefined });
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    if (provider === "codex") {
      const suffixThinking: Record<string, unknown> = {};
      applyThinking(sourceFormat, upstreamModel, suffixThinking, provider);
      if (suffixThinking.reasoning_effort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
          effort: suffixThinking.reasoning_effort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model);
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      trackPendingRequest(trackedModel, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    stripContinuityFields(translatedBody);
  }

  // Tool normalization: MCP-equivalent built-in dedup (Claude clients) + same-name
  // dedup for DeepSeek models (upstream rejects duplicate tool names on all endpoints).
  if (Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, { clientTool, model });
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Request line: one correlated summary (fmt + thinking + counts + account)
  if (log?.line) {
    const clientModel = (clientRawRequest?.body?.model as string | undefined) || `${provider}/${model}`;
    const msgN = countOf(translatedBody.messages) || countOf(translatedBody.input) || countOf(translatedBody.contents) || countOf(body.messages) || countOf(body.input) || 0;
    const toolN = countOf(translatedBody.tools) || countOf(body.tools) || 0;
    const fmtStr = passthrough ? `FMT: ${sourceFormat} (passthrough)` : `FMT: ${sourceFormat}→${targetFormat}`;
    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);
    const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null;
    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      `POST ${clientModel} → ${provider}/${model}`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      `${msgN} MSG`,
    ];
    if (toolN) parts.push(`${toolN} TOOL`);
    if (think) parts.push(`THINK:${think}`);
    parts.push(`ACC:${acc}`);
    log.line(reqTag, "▶", parts.join(" · "));
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
  // reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
  // Provider-scoped via quirks (shouldDefaultClaudeToolType): only gateways that declare
  // requireClaudeToolType get the explicit type. Applying it unconditionally breaks
  // Claude-format endpoints that only accept the legacy typeless tool shape - DeepSeek's
  // Anthropic-compatible endpoint 400s with "unknown variant `custom`" (#3905).
  if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }

  // Repair malformed tool payloads before dispatch: truncated JSON arguments, tool
  // results nothing asked for, a tool_choice naming a tool that is not in the array.
  // Any of those is a deterministic 400, and inside a combo it would burn every
  // member before the first one could answer. Fail-open - unchanged body on error.
  if (toolCallFallbackEnabled && Array.isArray(translatedBody.tools) && translatedBody.tools.length > 0) {
    repairToolPayload(translatedBody, finalFormat);
    // A call the client already rejected stays in the history it sends back on
    // the next turn, so repairing only the outbound body leaves the same broken
    // call being re-validated and rejected every turn after. Renaming it back to
    // the case the request declared and filling the arguments it lost is what
    // lets the turn continue.
    const rescued = rescueRequest(translatedBody);
    if (rescued.renamed || rescued.recovered || rescued.dropped) {
      log?.debug?.("TOOLRESCUE", `${rescued.renamed} renamed, ${rescued.recovered} recovered, ${rescued.dropped} dropped (history)`);
    }
  }

  // RTK: compress tool_result content. Skipped when already done pre-translate.
  const rtkStats = preTranslateRtk || compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  const headroomDiagnostics: HeadroomDiagnostics = {};
  const headroomStats = await compressWithHeadroom(translatedBody, { enabled: tokenSaverEnabled && headroomEnabled, url: headroomUrl, model: upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, timeoutMs: headroomTimeoutMs, diagnostics: headroomDiagnostics });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.("HEADROOM", `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`);
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.("HEADROOM", `reported token delta, but messages and outbound JSON shrank <5% | ${formatHeadroomSizeLog(headroomDiagnostics)}`);
    }
  } else if (tokenSaverEnabled && headroomEnabled) log?.warn?.("HEADROOM", `skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  // Context Pruning: keep system prompt and most recent messages
  if (tokenSaverEnabled && contextPruningEnabled) {
    // A preset only decides the default; an explicit limit still wins.
    const presetLimit = resolvePruningLimit(contextPruningLevel, undefined);
    const explicit = Number(maxMessagesLimit);
    const effective =
      presetLimit !== undefined && (!Number.isFinite(explicit) || explicit === 20)
        ? presetLimit
        : maxMessagesLimit || 20;
    const prunedTokens = measurePruningSavings(translatedBody, effective);
    pruneContextMessages(translatedBody, effective);
    if (prunedTokens > 0) recordTokenSavings(getAdapter(), { provider, model, pruning: prunedTokens });
    xf.push(`PRUNING:${effective}msgs`);
  }
  if (rtkStats?.hits?.length) {
    const rtkSaved = measureRtkSavings(rtkStats);
    if (rtkSaved > 0) recordTokenSavings(getAdapter(), { provider, model, rtk: rtkSaved });
    xf.push(`RTK:${rtkStats.hits.length}`);
  }

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    xf.push(`CAVEMAN:${cavemanLevel}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    xf.push(`PONYTAIL:${ponytailLevel}`);
  }

  // Custom prompt: user-authored instruction, independent of the savers above
  if (customPromptEnabled && injectCustomPrompt(translatedBody, finalFormat, customPrompt)) {
    xf.push(`CUSTOMPROMPT:${customPrompt.trim().length}c`);
  }

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled) {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: true, format: finalFormat, model: upstreamModel,
      minChars: pxpipeMinChars as number, timeoutMs: pxpipeTimeoutMs as number, transform: pxpipeTransform as ((args: { body: Uint8Array; model?: string; options?: { minCompressChars?: number; [key: string]: unknown } }) => Promise<{ applied?: boolean; reason?: string; detail?: string; body?: Uint8Array; info?: { compressedChars?: number; imageTokens?: number; imagePixels?: number; imageCount?: number; imageBytes?: number; baselineTokens?: number; [key: string]: unknown }; cache?: { ownsCacheControl?: boolean }; }> | { applied?: boolean; reason?: string; detail?: string; body?: Uint8Array; info?: { compressedChars?: number; imageTokens?: number; imagePixels?: number; imageCount?: number; imageBytes?: number; baselineTokens?: number; [key: string]: unknown }; cache?: { ownsCacheControl?: boolean }; } | null),
    });
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) xf.push(`PXPIPE:${pxpipeSummary.imageCount}img`);
    try { onPxpipeEvent?.({ provider, model, ...pxpipeSummary }); } catch { /* stats must not break requests */ }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

  // Pin cache breakpoints to the final body - every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody, cacheConfigFrom(providerOverrides));

  const executor = getExecutor(provider);
  trackPendingRequest(trackedModel, provider, connectionId, true);
  appendRequestLog({ model: trackedModel, provider, connectionId, status: "PENDING", requestedModel: model }).catch(() => { });

  const msgCount = countOf(translatedBody.messages) || countOf(translatedBody.input) || countOf(translatedBody.contents) || countOf(translatedBody.request?.contents) || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(trackedModel, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(trackedModel, provider, connectionId, false),
    log, provider, model, reqTag
  });

  const handleClientAbort = () => {
    if (clientSignal?.aborted) {
      streamController.handleDisconnect("client_closed");
      streamController.abort();
    }
  };
  if (clientSignal) {
    if (clientSignal.aborted) handleClientAbort();
    else clientSignal.addEventListener("abort", handleClientAbort, { once: true });
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
  };

  if (proxyOptions.relayUrl || proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | type=${proxyOptions.proxyType || "relay"} | relay=${proxyOptions.relayUrl || proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  try {
    const result = await executor.execute({
      model,
      body: translatedBody,
      stream,
      credentials,
      providerSessionId: sessionSeed,
      clientTool,
      signal: streamController.signal,
      log,
      reqTag,
      proxyOptions,
      providerOverrides,
    });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    const renamedToolNames = takeRenamedToolNames(translatedBody);
    if (renamedToolNames?.size) {
      toolNameMap = new Map([...(toolNameMap || []), ...renamedToolNames]);
    }
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    trackPendingRequest(trackedModel, provider, connectionId, false, true);
    appendRequestLog({ model: trackedModel, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}`, requestedModel: model }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, requestedModel,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });
    saveFailedUsage({ provider, model, requestedModel, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, statusCode: error.name === "AbortError" ? 499 : 502 });

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `ERROR 502 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`);
    }
    try {
      const { recordErrorLog } = await import("@/lib/localDb");
      recordErrorLog({
        provider,
        model,
        endpoint: clientRawRequest?.endpoint || "chat",
        statusCode: 502,
        errorMessage: errMsg,
        errorType: "executor_error",
        stack: error.stack || "",
      });
    } catch { /* fail open */ }
    const isHideError = Boolean(hideError);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, undefined, null, isHideError);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      // Mutate credentials after each successful refresh: rotating refresh_token
      // providers (xAI/grok-cli) issue a new RT on every refresh; without this,
      // refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
      // invalid_grant → auth_failed retryable=false.
      const newCredentials = await refreshWithRetry(async () => {
        const result = await executor.refreshCredentials(credentials, log);
        if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
          if (result.accessToken) credentials.accessToken = result.accessToken;
          credentials.refreshToken = result.refreshToken;
        }
        return result;
      }, 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({
            model,
            body: translatedBody,
            stream,
            credentials,
            providerSessionId: sessionSeed,
            clientTool,
            signal: streamController.signal,
            log,
            proxyOptions,
            providerOverrides,
          });
          if (retryResult.response.ok) {
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
          }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    const firstFailure = await parseUpstreamError(providerResponse, executor);
    let toolFallbackRecovered = false;

    // Tool fallback: a provider that refuses the tool payload outright would
    // otherwise hand the caller a tool error, and inside a combo it would spend
    // the whole chain on the same malformed shape. Re-dispatch with the tool
    // machinery relaxed one step at a time, stopping at the first level the
    // provider accepts. Only for rejections that actually name tools - a context
    // overflow or a policy refusal must still reach the caller untouched.
    if (toolCallFallbackEnabled && Array.isArray(translatedBody.tools) && translatedBody.tools.length > 0
        && isToolCallRejection(firstFailure.statusCode, firstFailure.message)) {
      for (let level = 1; level <= TOOL_FALLBACK_MAX_LEVEL; level++) {
        const fallbackBody = degradeToolPayload(translatedBody, level);
        if (!fallbackBody) break;
        try {
          const attempt = await executor.execute({
            model,
            body: fallbackBody,
            stream,
            credentials,
            providerSessionId: sessionSeed,
            clientTool,
            signal: streamController.signal,
            log,
            proxyOptions,
          });
          if (attempt.response.ok) {
            providerResponse = attempt.response;
            providerUrl = attempt.url;
            finalBody = attempt.transformedBody;
            providerResponseFormat = attempt.responseFormat || targetFormat;
            const renamed = takeRenamedToolNames(fallbackBody);
            if (renamed?.size) toolNameMap = new Map([...(toolNameMap || []), ...renamed]);
            reqLogger.logTargetRequest(providerUrl, attempt.headers, finalBody);
            toolFallbackRecovered = true;
            log?.info?.("TOOLFALLBACK", `recovered at level ${level} · ${provider}/${model} · after ${firstFailure.statusCode}`);
            break;
          }
          log?.debug?.("TOOLFALLBACK", `level ${level} rejected · ${provider}/${model} · ${attempt.response.status}`);
        } catch (e) {
          log?.debug?.("TOOLFALLBACK", `level ${level} threw · ${provider}/${model} · ${e.message}`);
        }
      }
    }

    if (!toolFallbackRecovered) {
      trackPendingRequest(trackedModel, provider, connectionId, false, true);
      const { statusCode, message, resetsAtMs } = firstFailure;
      appendRequestLog({ model: trackedModel, provider, connectionId, status: `FAILED ${statusCode}`, requestedModel: model }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId, requestedModel,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: message, status: statusCode, thinking: null },
        pxpipe: pxpipeSummary,
        status: "error"
      })).catch(() => { });
      saveFailedUsage({ provider, model, requestedModel, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, statusCode });

      const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
      if (log?.errorLine) {
        const urlStr = providerUrl ? `\n    URL: ${providerUrl}` : "";
        log.errorLine(reqTag, "✗", `ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`);
      }
      reqLogger.logError(new Error(message), finalBody || translatedBody);
      try {
        const { recordErrorLog } = await import("@/lib/localDb");
        recordErrorLog({
          provider,
          model,
          endpoint: clientRawRequest?.endpoint || "chat",
          statusCode,
          errorMessage: errMsg,
          errorType: "upstream_error",
        });
      } catch { /* fail open */ }
      const isHideError = Boolean(hideError);
      return createErrorResult(statusCode, errMsg, resetsAtMs, upstreamResponseHeaders(providerResponse.headers), isHideError);
    }
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, requestedModel, clientRawRequest, onRequestSuccess, pxpipe: pxpipeSummary, reqTag, log, pluginResult, modelMultipliers, isAntiProbe };
  const appendLog = (extra) => appendRequestLog({ model: trackedModel, provider, connectionId, requestedModel: model, ...extra }).catch(() => { })
  const trackDone = () => trackPendingRequest(trackedModel, provider, connectionId, false);

  // Upstream shape mismatch: a provider can answer with a finished JSON document
  // even though we asked it to stream (it ignores the flag, or the client omitted
  // `stream` so the flag never left). Piping that body through the SSE parser
  // emits zero frames - the client hangs on an empty stream and usage bills 0
  // tokens - so branch on what actually arrived, not on what we asked for.
  const rawUpstreamText = providerResponse && typeof providerResponse.clone === "function"
    ? await providerResponse.clone().text().catch(() => "")
    : "";
  if (stream && !isEventStreamResponse(providerResponse) && !looksLikeSseText(rawUpstreamText)) {
    const mismatchedBody = await readJsonBody(providerResponse);
    if (mismatchedBody === null) {
      // Nothing readable came back and the client never asked for a stream, so it
      // gets a clean gateway error instead of a response with no body to parse.
      if (!clientRequestedStreaming) {
        await logInvalidCodexUpstream({ provider, model, providerResponse, rawText: rawUpstreamText, statusCode: providerResponse?.status || HTTP_STATUS.BAD_GATEWAY, reqTag, log });
        appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
        streamController.handleComplete();
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
      }
    } else if (clientRequestedStreaming && isChatCompletionBody(mismatchedBody)) {
      // A streaming client gets the completion replayed as chunks, which the
      // normal pipeline then reshapes into its own format.
      providerResponse = sseResponseFromCompletion(mismatchedBody, providerResponse);
      providerResponseFormat = FORMATS.OPENAI;
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
      });
      streamController.handleComplete();
      return result;
    }
  }

  // Provider forced streaming but client wants JSON. The Responses wire always
  // streams upstream (openaiToOpenAIResponsesRequest pins stream:true), so a
  // non-stream OpenAI/native client behind a Responses upstream must also take
  // this path — handleForcedSSEToJson returns null when the body is not SSE.
  if (!clientRequestedStreaming && (providerRequiresStreaming || providerResponseFormat === FORMATS.OPENAI_RESPONSES)) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, customToolNames, toolNameMap, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, reqLogger, toolNameMap, customToolNames, trackDone, appendLog });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, userAgent, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, credentials });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
