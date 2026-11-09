import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb"
import { HTTP_STATUS, RESPONSE_PARSE_RETRY_ATTEMPTS } from "../../config/runtimeConfig.ts"
import { refreshWithRetry } from "../../services/tokenRefresh.ts"
import {
	collectJsonFrames,
	isEventStreamResponse,
	looksLikeSseText,
} from "../../transformer/jsonToStreamConverter.ts"
import {
	degrade as degradeToolPayload,
	isToolCallRejection,
	TOOL_FALLBACK_MAX_LEVEL,
} from "../../translator/concerns/toolCallFallback.ts"
import { createErrorResult, formatProviderError, parseUpstreamError } from "../../utils/error.ts"
import { takeRenamedToolNames } from "../../utils/opencodeFingerprint.ts"
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.ts"
import { tryToolFallback } from "./executorDispatchFallback.ts"
import { recordUpstreamError } from "./executorDispatchRecord.ts"
import { tryRefreshRetry } from "./executorDispatchRefresh.ts"
import { retryMalformedResponse } from "./executorDispatchRetry.ts"
import { executorThrowResult } from "./executorDispatchThrow.ts"
import type { LogSink } from "./options.ts"
import { buildRequestDetail, extractRequestConfig, saveFailedUsage } from "./requestDetail.ts"

/**
 * Check a successful buffered upstream response before handing it to a parser.
 * Streaming responses are deliberately checked only when the client has not
 * received a stream yet; once bytes are sent, replaying the request would
 * duplicate a partial answer.
 */
export async function responseBodyNeedsParseRetry(response) {
	// HTTP failures (including rate limits and upstream 5xx responses) must
	// follow the normal error/fallback path, never the malformed-body replay.
	if (!response?.ok || response.status >= 400) return false
	if (!response || typeof response.clone !== "function") return true
	let text = ""
	try {
		text = await response.clone().text()
	} catch {
		return true
	}
	if (!text.trim()) return true
	if (isEventStreamResponse(response) || looksLikeSseText(text)) {
		const frames = collectJsonFrames(text)
		if (frames.some((frame) => frame?.error || frame?.type === "error")) return false
		return frames.length === 0
	}
	try {
		const body = JSON.parse(text)
		// Some gateways incorrectly return an error envelope with HTTP 200.
		// Preserve it for the regular parser instead of replaying the request.
		if (body?.error || body?.type === "error" || body?.status === "error") return false
		return false
	} catch {
		return true
	}
}

/** Everything the dispatch step needs to call the executor and interpret the answer. */
export interface ExecutorDispatchContext {
	executor: any
	provider: string
	model: string
	trackedModel: string
	translatedBody: Record<string, unknown>
	stream: boolean
	credentials: Record<string, unknown>
	/** The resolved per-session id; forwarded to the executor on every retry. */
	sessionSeed: string
	clientTool: string | null
	proxyOptions: Record<string, unknown>
	providerOverrides: unknown
	targetFormat: string
	reqLogger: any
	reqTag: string
	log?: LogSink
	requestStartTime: number
	connectionId?: string
	requestedModel?: string
	apiKey?: string
	clientRawRequest?: { endpoint?: string; [key: string]: unknown }
	body: Record<string, unknown>
	pxpipeSummary: Record<string, unknown> | null
	toolCallFallbackEnabled?: boolean
	/** Set by the dispatch step when a refresh/re-dispatch renamed tools. */
	toolNameMap?: Map<string, unknown>
	/** Non-streaming clients (or streaming requests that never asked for SSE). */
	clientRequestedStreaming: boolean
	onCredentialsRefreshed?: (credentials: Record<string, unknown>) => void | Promise<void>
	streamController: {
		signal: AbortSignal
		handleError(error: unknown): void
		[key: string]: unknown
	}
	hideError?: boolean
}

type DispatchSuccess = {
	kind: "response"
	providerResponse: any
	providerUrl: any
	providerHeaders: any
	finalBody: any
	providerResponseFormat: string
	toolNameMap: any
}

/** The executor threw, the client aborted, or the upstream answered with an error. */
export type ExecutorDispatchResult = DispatchSuccess | { kind: "return"; result: unknown }

/**
 * Dispatch → refresh-retry → malformed-body retry → tool-fallback retry.
 *
 * Returns either a usable upstream `Response` or `{ kind: "return" }` carrying
 * the exact `Result` the handler must hand back to its caller. Every usage /
 * pending / request-log write that belongs to a failure happens here so the
 * caller's remaining job is purely response shaping.
 */
export async function dispatchExecutor(
	ctx: ExecutorDispatchContext,
): Promise<ExecutorDispatchResult> {
	const {
		executor,
		provider,
		model,
		trackedModel,
		translatedBody,
		stream,
		credentials,
		log,
		reqTag,
		reqLogger,
		proxyOptions,
		providerOverrides,
		clientTool,
		sessionSeed,
	} = ctx
	const {
		targetFormat,
		requestStartTime,
		connectionId,
		requestedModel,
		apiKey,
		clientRawRequest,
		body,
		pxpipeSummary,
		toolCallFallbackEnabled,
		hideError,
		streamController,
	} = ctx
	let { toolNameMap } = ctx

	// Execute request
	let providerResponse, providerUrl, providerHeaders, finalBody
	// Most executors return their registry format. Cursor AgentService is an
	// exception: it is decoded by the executor into OpenAI-compatible output.
	let providerResponseFormat = targetFormat
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
		})
		providerResponse = result.response
		providerUrl = result.url
		providerHeaders = result.headers
		finalBody = result.transformedBody
		providerResponseFormat = result.responseFormat || targetFormat
		const renamedToolNames = takeRenamedToolNames(translatedBody)
		if (renamedToolNames?.size) {
			toolNameMap = new Map([...(toolNameMap || []), ...renamedToolNames])
		}
		reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody)
	} catch (error) {
		return await executorThrowResult(ctx, error as Error)
	}

	{
		const _refreshState = {
			ctx,
			executor,
			providerResponse,
			credentials,
			log,
			reqTag,
			provider,
			model,
			translatedBody,
			stream,
			sessionSeed,
			clientTool,
			streamController,
			proxyOptions,
			providerOverrides,
			targetFormat,
			providerUrl,
			providerResponseFormat,
		}
		const _refreshed = await tryRefreshRetry(_refreshState)
		providerResponse = _refreshed.providerResponse
		providerUrl = _refreshed.providerUrl
		providerResponseFormat = _refreshed.providerResponseFormat
	}
	const _retryState = {
		providerResponse,
		providerUrl,
		providerHeaders,
		finalBody,
		providerResponseFormat,
	}
	await retryMalformedResponse({
		..._retryState,
		executor,
		model,
		translatedBody,
		stream,
		credentials,
		sessionSeed,
		clientTool,
		streamController,
		log,
		proxyOptions,
		providerOverrides,
		reqLogger,
		provider,
		targetFormat,
		set providerResponse(v) {
			_retryState.providerResponse = v
		},
		set providerUrl(v) {
			_retryState.providerUrl = v
		},
		set providerHeaders(v) {
			_retryState.providerHeaders = v
		},
		set finalBody(v) {
			_retryState.finalBody = v
		},
		set providerResponseFormat(v) {
			_retryState.providerResponseFormat = v
		},
	})
	providerResponse = _retryState.providerResponse
	providerUrl = _retryState.providerUrl
	providerHeaders = _retryState.providerHeaders
	finalBody = _retryState.finalBody
	providerResponseFormat = _retryState.providerResponseFormat

	// Non-streaming responses are fully buffered before reaching the caller, so
	// an invalid document can be retried safely. For a streaming client, only
	// retry a non-SSE response before its first byte is forwarded.
	if (providerResponse?.ok && !ctx.clientRequestedStreaming) {
		await retryMalformedResponse({
			..._retryState,
			executor,
			model,
			translatedBody,
			stream,
			credentials,
			sessionSeed,
			clientTool,
			streamController,
			log,
			proxyOptions,
			providerOverrides,
			reqLogger,
			provider,
			targetFormat,
			set providerResponse(v) {
				_retryState.providerResponse = v
			},
			set providerUrl(v) {
				_retryState.providerUrl = v
			},
			set providerHeaders(v) {
				_retryState.providerHeaders = v
			},
			set finalBody(v) {
				_retryState.finalBody = v
			},
			set providerResponseFormat(v) {
				_retryState.providerResponseFormat = v
			},
		})
		providerResponse = _retryState.providerResponse
		providerUrl = _retryState.providerUrl
		providerHeaders = _retryState.providerHeaders
		finalBody = _retryState.finalBody
		providerResponseFormat = _retryState.providerResponseFormat
	} else if (providerResponse?.ok && stream) {
		const initialText =
			typeof providerResponse.clone === "function"
				? await providerResponse
						.clone()
						.text()
						.catch(() => "")
				: ""
		if (!isEventStreamResponse(providerResponse) && !looksLikeSseText(initialText)) {
			await retryMalformedResponse({
				..._retryState,
				executor,
				model,
				translatedBody,
				stream,
				credentials,
				sessionSeed,
				clientTool,
				streamController,
				log,
				proxyOptions,
				providerOverrides,
				reqLogger,
				provider,
				targetFormat,
				set providerResponse(v) {
					_retryState.providerResponse = v
				},
				set providerUrl(v) {
					_retryState.providerUrl = v
				},
				set providerHeaders(v) {
					_retryState.providerHeaders = v
				},
				set finalBody(v) {
					_retryState.finalBody = v
				},
				set providerResponseFormat(v) {
					_retryState.providerResponseFormat = v
				},
			})
			providerResponse = _retryState.providerResponse
			providerUrl = _retryState.providerUrl
			providerHeaders = _retryState.providerHeaders
			finalBody = _retryState.finalBody
			providerResponseFormat = _retryState.providerResponseFormat
		}
	}

	// Provider returned error
	if (!providerResponse.ok) {
		const firstFailure = await parseUpstreamError(providerResponse, executor)
		let toolFallbackRecovered = false
		if (
			toolCallFallbackEnabled &&
			Array.isArray(translatedBody.tools) &&
			translatedBody.tools.length > 0 &&
			isToolCallRejection(firstFailure.statusCode, firstFailure.message)
		) {
			const _fb = {
				providerResponse,
				providerUrl,
				finalBody,
				providerResponseFormat,
				toolNameMap,
				executor,
				model,
				translatedBody,
				stream,
				credentials,
				sessionSeed,
				clientTool,
				streamController,
				log,
				proxyOptions,
				provider,
				targetFormat,
				reqLogger,
				toolCallFallbackEnabled,
				firstFailure,
			}
			const fbResult = await tryToolFallback(_fb)
			providerResponse = _fb.providerResponse
			providerUrl = _fb.providerUrl
			finalBody = _fb.finalBody
			providerResponseFormat = _fb.providerResponseFormat
			toolNameMap = _fb.toolNameMap
			toolFallbackRecovered = fbResult.toolFallbackRecovered
		}
		const _rec = await recordUpstreamError({
			firstFailure,
			providerResponse,
			provider,
			connectionId,
			trackedModel,
			model,
			requestedModel,
			requestStartTime,
			body,
			stream,
			finalBody,
			translatedBody,
			pxpipeSummary,
			apiKey,
			clientRawRequest,
			log,
			reqTag,
			providerUrl,
			reqLogger,
			hideError,
		})
		if (_rec) return _rec
	}

	return {
		kind: "response",
		providerResponse,
		providerUrl,
		providerHeaders,
		finalBody,
		providerResponseFormat,
		toolNameMap,
	}
}
