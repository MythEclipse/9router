import { getClientIp } from "@9router/auth/loginLimiter"
import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import { getSettings } from "@/lib/localDb"
import { isValidApiKey, shouldLogAuthFailure } from "../../services/auth.ts"
import { enforceKeyAccess, getKeyAccessContext } from "../../services/keyAccess.ts"
import * as log from "../../utils/logger.ts"
import type { ChatErrorResponses } from "./responses.ts"

/** What an authorized request carries into routing. */
export interface AuthorizedChat {
	ok: true
	settings: Awaited<ReturnType<typeof getSettings>>
	keyAccess: Awaited<ReturnType<typeof getKeyAccessContext>>
}

/**
 * The auth + validation gate for a chat request.
 *
 * Returns the denial `Response` when the request may not proceed, otherwise the
 * settings and key-access context every downstream resolver needs.
 *
 * `modelStr` is the client-facing model name: it is what the key's model
 * allow-list and grants are checked against.
 */
export async function authorizeChatRequest({
	request,
	apiKey,
	modelStr,
	errorResponse,
}: {
	request: Request
	apiKey: string | null
	modelStr: string
	errorResponse: ChatErrorResponses["errorResponse"]
}): Promise<Response | AuthorizedChat> {
	// Enforce API key if provided or if required by settings
	const settings = await getSettings()
	const keyAccess = await getKeyAccessContext(request)
	if (settings.requireApiKey && !apiKey) {
		if (shouldLogAuthFailure("chat", getClientIp(request), null)) {
			log.warn("AUTH", "Missing API key (requireApiKey=true)")
		}
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key")
	}

	if (apiKey) {
		const clientIp = getClientIp(request)
		const valid = await isValidApiKey(apiKey, modelStr, clientIp)
		if (valid === "KEY_DISABLED") {
			log.warn("AUTH", "API key is disabled")
			return errorResponse(HTTP_STATUS.FORBIDDEN, "API key is disabled")
		}
		if (valid === "QUOTA_EXCEEDED") {
			log.warn("AUTH", "API key quota exceeded")
			return errorResponse(HTTP_STATUS.RATE_LIMITED, "API key token limit exceeded")
		}
		if (valid === "RPM_EXCEEDED") {
			log.warn("AUTH", "API key RPM limit exceeded")
			return errorResponse(HTTP_STATUS.RATE_LIMITED, "API key rate limit exceeded (RPM limit reached)")
		}
		if (valid === "TPM_EXCEEDED") {
			log.warn("AUTH", "API key TPM limit exceeded")
			return errorResponse(HTTP_STATUS.RATE_LIMITED, "API key rate limit exceeded (TPM limit reached)")
		}
		if (valid === "MODEL_NOT_ALLOWED") {
			log.warn("AUTH", `Model "${modelStr}" not allowed for this API key`)
			return errorResponse(
				HTTP_STATUS.FORBIDDEN,
				`Model "${modelStr}" is not allowed for this API key`,
			)
		}
		if (valid === "KEY_EXPIRED") {
			log.warn("AUTH", "API key expired")
			return errorResponse(HTTP_STATUS.FORBIDDEN, "API key has expired")
		}
		if (!valid && settings.requireApiKey) {
			if (shouldLogAuthFailure("chat", clientIp, apiKey.slice(0, 8))) {
				log.warn("AUTH", "Invalid API key (requireApiKey=true)")
			}
			return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key")
		}
	}

	// Gate against the same resolved studio/combo identity that will be routed,
	// while retaining combo grant semantics (aliases are not extra permissions).
	let accessModel = modelStr
	if (!modelStr.includes("/")) {
		try {
			const { getStudioModel } = await import("@9router/db/repos/modelEditorRepo")
			const studio = await getStudioModel(modelStr)
			if (studio?.targetModel) accessModel = String(studio.targetModel).trim()
		} catch {
			/* studio lookup is best-effort; the gate will check the raw name */
		}
	}
	const accessDenied = await enforceKeyAccess(keyAccess, accessModel)
	if (accessDenied) return accessDenied

	return { ok: true, settings, keyAccess }
}
