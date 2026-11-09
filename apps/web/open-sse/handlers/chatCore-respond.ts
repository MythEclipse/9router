/** chatCore response branching. */

import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import {
	isChatCompletionBody,
	isEventStreamResponse,
	jsonResponseFromBody,
	looksLikeSseText,
	readJsonBody,
	sseResponseFromCompletion,
} from "../transformer/jsonToStreamConverter.ts"
import { FORMATS } from "../translator/formats.ts"
import { createErrorResult } from "../utils/error.ts"
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.ts"
import type { ChatCoreResult } from "./chatCore/options.ts"
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.ts"
import { buildOnStreamComplete, handleStreamingResponse } from "./chatCore/streamingHandler.ts"
import { logInvalidCodexUpstream } from "./chatCore-helpers.ts"

export async function respondFromUpstream(ctx) {
	let { providerResponse, providerResponseFormat } = ctx
	const {
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
		logInvalidCodexUpstream,
	} = ctx
	const log = ctx.log
	const { provider, model, reqTag } = sharedCtx
	const clientModel = undefined
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
