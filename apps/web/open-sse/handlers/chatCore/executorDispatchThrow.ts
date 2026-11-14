/** Executor dispatch throw handling. */
import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb"
import { HTTP_STATUS } from "../../config/runtimeConfig.ts"
import { createErrorResult, formatProviderError } from "../../utils/error.ts"
import type { ExecutorDispatchContext, ExecutorDispatchResult } from "./executorDispatch.ts"
import { buildRequestDetail, extractRequestConfig, saveFailedUsage } from "./requestDetail.ts"

export async function executorThrowResult(
	ctx: ExecutorDispatchContext,
	error: Error,
): Promise<ExecutorDispatchResult> {
	const {
		trackedModel,
		provider,
		connectionId,
		requestStartTime,
		body,
		stream,
		translatedBody,
		pxpipeSummary,
		apiKey,
		clientRawRequest,
		log,
		reqTag,
		hideError,
		model,
		requestedModel,
		streamController,
	} = ctx
	// A provider-side rejection is the caller's mistake to fix, not a gateway
	// failure: surface its own status and code so an agent can compact and retry
	// instead of treating it as an upstream outage. Computed once here so the
	// request log, usage row, error log and response all agree.
	const reportedStatus = Number((error as { statusCode?: number }).statusCode)
	const isClientError =
		Number.isFinite(reportedStatus) && reportedStatus >= 400 && reportedStatus < 500
	const effectiveStatus =
		error.name === "AbortError" ? 499 : isClientError ? reportedStatus : HTTP_STATUS.BAD_GATEWAY
	{
		trackPendingRequest(trackedModel, provider, connectionId, false, true)
		appendRequestLog({
			model: trackedModel,
			provider,
			connectionId,
			status: `FAILED ${effectiveStatus}`,
			requestedModel: model,
		}).catch(() => {})
		saveRequestDetail(
			buildRequestDetail({
				provider,
				model,
				connectionId,
				requestedModel,
				latency: { ttft: 0, total: Date.now() - requestStartTime },
				tokens: { prompt_tokens: 0, completion_tokens: 0 },
				request: extractRequestConfig(body, stream),
				providerRequest: translatedBody || null,
				response: {
					error: error.message || String(error),
					status: effectiveStatus,
					thinking: null,
				},
				pxpipe: pxpipeSummary,
				status: "error",
			}),
		).catch(() => {})
		saveFailedUsage({
			provider,
			model,
			requestedModel,
			connectionId,
			apiKey,
			endpoint: clientRawRequest?.endpoint,
			statusCode: effectiveStatus,
		})

		if (error.name === "AbortError") {
			streamController.handleError(error)
			return {
				kind: "return",
				result: createErrorResult(499, "Request aborted"),
			} as ExecutorDispatchResult
		}
		const errMsg = formatProviderError(error, provider, model, effectiveStatus)
		if (log?.errorLine) {
			log.errorLine(
				reqTag,
				"✗",
				`ERROR ${effectiveStatus} · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`,
			)
		}
		try {
			const { recordErrorLog } = await import("@/lib/localDb")
			recordErrorLog({
				provider,
				model,
				endpoint: clientRawRequest?.endpoint || "chat",
				statusCode: effectiveStatus,
				errorMessage: errMsg,
				errorType: "executor_error",
				stack: error.stack || "",
			})
		} catch {
			/* fail open */
		}
		const isHideError = Boolean(hideError)
		if (isClientError) {
			return {
				kind: "return",
				result: createErrorResult(effectiveStatus, errMsg, undefined, null, isHideError),
			}
		}
		return {
			kind: "return",
			result: createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, undefined, null, isHideError),
		}
	}
}
