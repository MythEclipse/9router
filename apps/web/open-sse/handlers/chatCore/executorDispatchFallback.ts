/** Executor dispatch tool fallback. */
import {
	degrade as degradeToolPayload,
	isToolCallRejection,
	TOOL_FALLBACK_MAX_LEVEL,
} from "../../translator/concerns/toolCallFallback.ts"
import { takeRenamedToolNames } from "../../utils/opencodeFingerprint.ts"

export async function tryToolFallback(state) {
	let toolFallbackRecovered = false
	const {
		translatedBody,
		toolCallFallbackEnabled,
		firstFailure,
		executor,
		model,
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
	} = state
	if (
		toolCallFallbackEnabled &&
		Array.isArray(translatedBody.tools) &&
		translatedBody.tools.length > 0 &&
		isToolCallRejection(firstFailure.statusCode, firstFailure.message)
	) {
		// provider accepts. Only for rejections that actually name tools - a context
		// overflow or a policy refusal must still reach the caller untouched.
		if (
			toolCallFallbackEnabled &&
			Array.isArray(translatedBody.tools) &&
			translatedBody.tools.length > 0 &&
			isToolCallRejection(firstFailure.statusCode, firstFailure.message)
		) {
			for (let level = 1; level <= TOOL_FALLBACK_MAX_LEVEL; level++) {
				const fallbackBody = degradeToolPayload(translatedBody, level)
				if (!fallbackBody) break
				try {
					// No reqTag here - the original loop omitted it, and adding it would
					// change the tag the degraded retry logs under.
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
					})
					if (attempt.response.ok) {
						state.providerResponse = attempt.response
						state.providerUrl = attempt.url
						state.finalBody = attempt.transformedBody
						state.providerResponseFormat = attempt.responseFormat || targetFormat
						const renamed = takeRenamedToolNames(fallbackBody)
						if (renamed?.size) state.toolNameMap = new Map([...(state.toolNameMap || []), ...renamed])
						reqLogger.logTargetRequest(state.providerUrl, attempt.headers, state.finalBody)
						toolFallbackRecovered = true
						state.toolFallbackRecovered = true
						log?.info?.(
							"TOOLFALLBACK",
							`recovered at level ${level} · ${provider}/${model} · after ${firstFailure.statusCode}`,
						)
						break
					}
					log?.debug?.(
						"TOOLFALLBACK",
						`level ${level} rejected · ${provider}/${model} · ${attempt.response.status}`,
					)
				} catch (e) {
					log?.debug?.("TOOLFALLBACK", `level ${level} threw · ${provider}/${model} · ${e.message}`)
				}
			}
		}
	}
	return { toolFallbackRecovered }
}
