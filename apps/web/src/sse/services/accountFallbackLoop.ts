import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import { errorResponse, unavailableResponse } from "open-sse/utils/error"
import * as log from "../utils/logger.ts"

/**
 * The "no usable credential" tail of the account-fallback loop shared by every
 * modality handler (embeddings, search, fetch, image, stt, tts, video, systemone).
 *
 * All eight handlers ran byte-identical copies of the same three decisions:
 *   1. every account is cooled down -> 503 carrying the retry-after
 *   2. no account matched at all    -> 400 "no credentials for provider"
 *   3. we exhausted the rotation    -> 503 with the last error
 *
 * `label` is the log tag the handler already used, and `subject` is how that
 * handler names the model in messages ("provider/model", or just the provider
 * for the search-style handlers). Logging is opt-in per handler because the
 * stt/tts/video handlers deliberately do not echo the upstream error string.
 *
 * @returns a Response when the loop must stop, or null to keep going.
 */
export function unavailableCredentialResponse({
	credentials,
	excludeConnectionIds,
	lastError,
	lastStatus,
	subject,
	label,
	logAttemptFailure = true,
	cooldownSubject = subject,
}) {
	if (credentials && !credentials.allRateLimited) return null

	if (credentials?.allRateLimited) {
		const errorMsg = lastError || credentials.lastError || "Unavailable"
		const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE
		if (logAttemptFailure) {
			log.warn(label, `[${cooldownSubject}] ${errorMsg} (${credentials.retryAfterHuman})`)
		}
		return unavailableResponse(
			status,
			`[${cooldownSubject}] ${errorMsg}`,
			credentials.retryAfter,
			credentials.retryAfterHuman,
		)
	}

	if (excludeConnectionIds.size === 0) {
		if (logAttemptFailure) log.error("AUTH", `No credentials for provider: ${subject}`)
		return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${subject}`)
	}

	if (logAttemptFailure) log.warn(label, "No more accounts available", { provider: subject })
	return errorResponse(
		lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
		lastError || "All accounts unavailable",
	)
}
