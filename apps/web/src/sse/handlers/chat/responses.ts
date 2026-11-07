import type { detectFormatByEndpoint } from "open-sse/translator/formats"
import {
	errorResponse as buildErrorResponse,
	unavailableResponse as buildUnavailableResponse,
} from "open-sse/utils/error"

/**
 * The protocol-specific response builders a chat handler needs.
 *
 * `clientFormat` is the format detected from the endpoint (+ body), so these are
 * bound per request rather than imported directly by the fallback helpers.
 */
export interface ChatErrorResponses {
	errorResponse: (
		status: number,
		message: string,
		extraHeaders?: Record<string, string> | null,
		hideError?: boolean,
	) => Response
	unavailableResponse: (
		status: number,
		message: string,
		retryAfter: number | string | null,
		retryAfterHuman: string | null,
		extraHeaders?: Record<string, string> | null,
	) => Response
	/** The 499 every handler returns when the caller has already gone away. */
	abortResponse: () => Response
}

/** Client format as returned by `detectFormatByEndpoint`. */
export type ClientFormat = ReturnType<typeof detectFormatByEndpoint>

/** Bind the shared error builders to one client format. */
export function createErrorResponses(clientFormat: ClientFormat | null): ChatErrorResponses {
	return {
		errorResponse: (status, message, extraHeaders = null, hideError = false) =>
			buildErrorResponse(status, message, extraHeaders, hideError, clientFormat),
		unavailableResponse: (status, message, retryAfter, retryAfterHuman, extraHeaders = null) =>
			buildUnavailableResponse(
				status,
				message,
				retryAfter,
				retryAfterHuman,
				extraHeaders,
				clientFormat,
			),
		abortResponse: abortedResponse,
	}
}

/** The 499 every handler returns when the caller has already gone away. */
export function abortedResponse(): Response {
	return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
		status: 499,
		headers: { "Content-Type": "application/json" },
	})
}
