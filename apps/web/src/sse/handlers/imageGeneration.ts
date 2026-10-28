import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore"
import { getImageAdapter } from "open-sse/handlers/imageProviders/index"
import { handleComboChat } from "open-sse/services/combo"
import { errorResponse } from "open-sse/utils/error"
import { getSettings } from "@/lib/localDb"
import { saveRequestUsage } from "@/lib/usageDb"
import { unavailableCredentialResponse } from "../services/accountFallbackLoop.ts"
import {
	apiKeyGateFailure,
	clearAccountError,
	extractApiKey,
	getProviderCredentials,
	isValidApiKey,
	markAccountUnavailable,
	shouldTryNextAccount,
} from "../services/auth.ts"
import { enforceKeyAccess, getKeyAccessContext } from "../services/keyAccess.ts"
import { getComboModels, getModelInfo } from "../services/model.ts"
import { checkAndRefreshToken, updateProviderCredentials } from "../services/tokenRefresh.ts"
import * as log from "../utils/logger.ts"

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui", "veoaifree-web"])

/** Options handleSingleModelImage receives from the combo and single-model paths. */
interface ImageRunOptions {
	wantsStream: boolean
	binaryOutput: boolean
	preferredConnectionId: string | null
	apiKey: string | null
	endpoint: string
}

/** The error arm of an imageGenerationCore result. */
interface ImageFailure {
	success: false
	status: number
	error: string
	response: Response
}

function recordImageRequestUsage({ provider, model, connectionId, apiKey, endpoint, usage }) {
	if (!usage || typeof usage !== "object") return
	const promptTokens = usage.prompt_tokens
	const completionTokens = usage.completion_tokens
	if (
		!Number.isSafeInteger(promptTokens) ||
		promptTokens < 0 ||
		!Number.isSafeInteger(completionTokens) ||
		completionTokens < 0
	) {
		return
	}

	saveRequestUsage({
		provider,
		model,
		connectionId: connectionId || undefined,
		apiKey: apiKey || undefined,
		endpoint: endpoint || null,
		tokens: usage,
		status: "success",
	}).catch(() => {})
}

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
	let body
	try {
		body = await request.json()
	} catch {
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body")
	}

	const url = new URL(request.url)
	const preferredConnectionId = request.headers.get("x-connection-id") || null
	const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream")
	const binaryOutput = url.searchParams.get("response_format") === "binary"
	const modelStr = body.model

	const apiKey = extractApiKey(request)
	const settings = await getSettings()
	if (settings.requireApiKey && !apiKey) {
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key")
	}
	if (apiKey) {
		const failure = apiKeyGateFailure(await isValidApiKey(apiKey), settings.requireApiKey)
		if (failure) {
			return errorResponse(failure.status, failure.message)
		}
	}

	if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model")
	if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt")

	// Per-key access control: requested target, before combo expansion.
	const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr)
	if (keyAccessDenied) return keyAccessDenied

	// Combo expansion: model may be a combo name → run fallback/round-robin across models
	const comboModels = await getComboModels(modelStr)
	if (comboModels) {
		const comboStrategies = settings.comboStrategies || {}
		const comboStrategy =
			comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback"
		const comboStickyLimit = settings.comboStickyRoundRobinLimit
		log.info(
			"IMAGE",
			`Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
		)
		return handleComboChat({
			body,
			models: comboModels,
			handleSingleModel: (b, m) =>
				handleSingleModelImage(b, m, {
					wantsStream,
					binaryOutput,
					preferredConnectionId,
					apiKey,
					endpoint: url.pathname,
				}),
			log,
			comboName: modelStr,
			comboStrategy,
			comboStickyLimit,
		})
	}

	return handleSingleModelImage(body, modelStr, {
		wantsStream,
		binaryOutput,
		preferredConnectionId,
		apiKey,
		endpoint: url.pathname,
	})
}

async function handleSingleModelImage(body, modelStr, runOptions: ImageRunOptions) {
	const { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint } = runOptions
	const modelInfo = await getModelInfo(modelStr)
	if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format")

	const { provider, model } = modelInfo

	// noAuth providers - no credential needed
	if (NO_AUTH_PROVIDERS.has(provider)) {
		const result = await handleImageGenerationCore({
			body,
			modelInfo: { provider, model },
			credentials: null,
			binaryOutput,
			log,
			onCredentialsRefreshed: null,
			onRequestSuccess: null,
			onUsage: null,
		})
		if (result.success) return result.response
		// A failed result is the error envelope: status/error are present.
		const failure = result as ImageFailure
		return errorResponse(
			failure.status || HTTP_STATUS.BAD_GATEWAY,
			failure.error || "Image generation failed",
		)
	}

	// Credentialed providers - fallback loop
	const excludeConnectionIds = new Set<string>()
	let lastError = null
	let lastStatus = null

	while (true) {
		const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
			preferredConnectionId,
		})

		const unavailable = unavailableCredentialResponse({
			credentials,
			excludeConnectionIds,
			lastError,
			lastStatus,
			subject: provider,
			label: "IMAGE",
			logAttemptFailure: false,
			cooldownSubject: `${provider}/${model}`,
		})
		if (unavailable) return unavailable

		const refreshedCredentials = await checkAndRefreshToken(provider, credentials)

		// Skip accounts the adapter knows cannot generate images (e.g. ChatGPT Free on codex)
		// without locking them: they stay usable for chat.
		const adapter = getImageAdapter(provider)
		if (adapter?.canUseCredentials && !adapter.canUseCredentials(refreshedCredentials)) {
			log.info(
				"IMAGE",
				`[${provider}/${model}] skip connection ${credentials.connectionId.slice(0, 8)}: plan not entitled to image generation`,
			)
			excludeConnectionIds.add(credentials.connectionId)
			lastError =
				lastError || "No account entitled to image generation (ChatGPT Free plans are not supported)"
			lastStatus = lastStatus || HTTP_STATUS.FORBIDDEN
			continue
		}

		const result = await handleImageGenerationCore({
			body,
			modelInfo: { provider, model },
			credentials: refreshedCredentials,
			streamToClient: wantsStream,
			binaryOutput,
			log,
			onCredentialsRefreshed: async (newCreds) => {
				await updateProviderCredentials(credentials.connectionId, {
					accessToken: newCreds.accessToken,
					refreshToken: newCreds.refreshToken,
					providerSpecificData: newCreds.providerSpecificData,
					testStatus: "active",
				})
			},
			onUsage: (usage) => {
				recordImageRequestUsage({
					provider,
					model,
					connectionId: credentials.connectionId,
					apiKey,
					endpoint,
					usage,
				})
			},
			onRequestSuccess: async () => {
				await clearAccountError(credentials.connectionId, credentials, model)
				// Cookies that rotate on use (Clerk `__client`) are mutated in place by
				// the executor — persist the new value so the chain does not drift.
				if (refreshedCredentials.apiKey && refreshedCredentials.apiKey !== credentials.apiKey) {
					await updateProviderCredentials(credentials.connectionId, {
						apiKey: refreshedCredentials.apiKey,
					})
				}
			},
		})

		if (result.success) return result.response

		// A failed result is the error envelope: status/error are present.
		const failure = result as ImageFailure
		const { shouldFallback } = await markAccountUnavailable(
			credentials.connectionId,
			failure.status,
			failure.error,
			provider,
			model,
		)

		if (shouldTryNextAccount(credentials.connectionId, failure.status, shouldFallback)) {
			excludeConnectionIds.add(credentials.connectionId)
			lastError = failure.error
			lastStatus = failure.status
			continue
		}

		return failure.response
	}
}
