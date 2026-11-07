import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import {
	augmentModelsWithCapacityAdapter,
	getActiveAdapterStrategy,
} from "open-sse/services/capacityAdapter"
import { detectRequiredCapabilities } from "open-sse/services/combo"
import { detectFormatByEndpoint } from "open-sse/translator/formats"
import { handleBypassRequest } from "open-sse/utils/bypassHandler"
import { stripModelContextMarker } from "open-sse/utils/modelMarkers"
import { getSettings } from "@/lib/localDb"
import { parseJsonBody } from "@/shared/utils/parseJsonBody"
import { isClaudeEndpoint, validateClaudeMessageBody } from "../protocol/claudeValidation.ts"
import { isResponsesEndpoint, validateResponsesBody } from "../protocol/responsesValidation.ts"
import { extractApiKey } from "../services/auth.ts"
import { filterAdapterModels, getKeyAccessContext } from "../services/keyAccess.ts"
import { getComboModels } from "../services/model.ts"
import * as log from "../utils/logger.ts"
import {
	type AccountAttemptContext,
	type AccountFallbackLoop,
	tryNextAccount,
} from "./chat/accountAttempt.ts"
import { type AuthorizedChat, authorizeChatRequest } from "./chat/authGate.ts"
import {
	comboSessionId,
	dispatchCombo,
	resolveComboEntryName,
	resolveComboStrategy,
} from "./chat/comboDispatch.ts"
import { FallbackState } from "./chat/fallbackState.ts"
import { resolveModelOverrides } from "./chat/modelOverrides.ts"
import { resolveComboMembers, resolveModelTarget } from "./chat/modelTarget.ts"
import { abortedResponse, createErrorResponses } from "./chat/responses.ts"

/** The raw client request as the logger and panel handlers expect to see it. */
interface ClientRawRequest {
	endpoint?: string
	body?: Record<string, unknown>
	headers?: Record<string, string>
	[key: string]: unknown
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(
	request: Request,
	clientRawRequest: ClientRawRequest | null = null,
) {
	const pathname = new URL(request.url).pathname
	let clientFormat: ReturnType<typeof detectFormatByEndpoint> = detectFormatByEndpoint(
		pathname,
		undefined,
	)
	const { errorResponse } = createErrorResponses(clientFormat)

	let body
	try {
		body = await parseJsonBody(request)
	} catch {
		log.warn("CHAT", "Invalid JSON body")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body")
	}
	clientFormat = detectFormatByEndpoint(pathname, body)

	if (isClaudeEndpoint(pathname)) {
		const validationError = validateClaudeMessageBody(body)
		if (validationError) return validationError
	} else if (isResponsesEndpoint(pathname)) {
		const validationError = validateResponsesBody(body)
		if (validationError) return validationError
	}

	// Build clientRawRequest for logging (if not provided)
	if (!clientRawRequest) {
		const url = new URL(request.url)
		clientRawRequest = {
			endpoint: url.pathname,
			body,
			headers: Object.fromEntries(request.headers.entries()),
		}
	}
	// Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
	// no combo, alias or provider/model pair, so it must not reach resolution.
	// The capability travels in the anthropic-beta header, forwarded as-is.
	const { model: modelStr, contextMarker } = stripModelContextMarker(body.model)
	if (contextMarker) body.model = modelStr

	// Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

	// Log API key (masked)
	const authHeader = request.headers.get("Authorization")
	const apiKey = extractApiKey(request)
	if (authHeader && apiKey) {
		const masked = log.maskKey(apiKey)
		log.debug("AUTH", `API Key: ${masked}`)
	} else {
		log.debug("AUTH", "No API key provided (local mode)")
	}

	if (typeof modelStr !== "string" || !modelStr.trim()) {
		log.warn("CHAT", "Missing model")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model")
	}

	const authorized = (await authorizeChatRequest({
		request,
		apiKey,
		modelStr,
		errorResponse,
	})) as AuthorizedChat | Response
	if (authorized instanceof Response) return authorized
	const { settings, keyAccess } = authorized

	// Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
	const userAgent = request?.headers?.get("user-agent") || ""
	const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming)
	// `handleBypassRequest` answers with a `{ success, response }` envelope, never a
	// bare Response. The historical `bypassResponse.response || bypassResponse`
	// fallback was therefore unreachable at runtime, but it made this function's
	// return type the whole envelope and so leaked into every route that awaits
	// `handleChat`. Reading only `.response` keeps the behaviour identical and the
	// return type `Response`.
	if (bypassResponse) return (bypassResponse as { response: Response }).response

	const requiredCapabilities = detectRequiredCapabilities(body)

	// Check if model is a combo (has multiple models with fallback)
	// A studio name may itself point at a combo; resolve it first so the combo
	// strategy applies, with a hop limit so a studio/combo cycle cannot recurse.
	const comboEntryName = await resolveComboEntryName(modelStr)
	const comboModels = await getComboModels(comboEntryName)

	if (comboModels) {
		// Check for combo-specific strategy first, fallback to global
		const comboStrategies = settings.comboStrategies || {}
		const comboCfg = comboStrategies[comboEntryName] || {}
		const comboStrategy = resolveComboStrategy(comboEntryName, settings)
		const sessionId = comboSessionId({ request, body, apiKey })
		const { augmentedModels, adapterAdded } = await resolveComboMembers({
			comboModels,
			requiredCapabilities,
			settings,
			keyAccess,
		})

		// Tracks which connection served the member currently being awaited, so an
		// empty answer can be charged to that account instead of the whole combo.
		const lastServed: { model?: string; connectionId?: string; provider?: string } | null = {}
		// The combo name is what the caller asked for, so it is what every member's
		// response must be labelled with. Without this the client sees whichever
		// internal provider/model happened to serve the request.
		const aliasModel = comboEntryName

		// Records which account served `servedModel` so an empty answer is charged
		// to that connection rather than to the whole combo.
		const onServe = (servedModel, creds) => {
			lastServed.model = servedModel
			lastServed.connectionId = creds.connectionId
			lastServed.provider = creds.provider ?? null
		}

		return dispatchCombo({
			body,
			models: augmentedModels,
			comboModels,
			augmentedModels,
			adapterAdded,
			handleSingleModel: (b, m) =>
				handleSingleModelChat(b, m, clientRawRequest, request, apiKey, aliasModel, onServe),
			comboName: comboEntryName,
			comboStrategy,
			settings,
			comboCfg,
			request,
			sessionId,
			lastServed,
		})
	}

	// Single model request - may still switch to a capacity-adapter model if the
	// target lacks a capability the request needs (e.g. no vision, request has an image).
	const soloAugmented = await filterAdapterModels(
		keyAccess,
		augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings),
		[modelStr],
	)
	if (soloAugmented.length > 1) {
		const adapterAdded = soloAugmented.filter((m) => m !== modelStr)
		log.info(
			"CHAT",
			`Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`,
		)
		const lastServed: { model?: string; connectionId?: string; provider?: string } | null = {}
		const onServe = (servedModel, creds) => {
			lastServed.model = servedModel
			lastServed.connectionId = creds.connectionId
			lastServed.provider = creds.provider ?? null
		}
		return dispatchCombo({
			body,
			models: soloAugmented,
			comboModels: [modelStr],
			augmentedModels: soloAugmented,
			adapterAdded,
			handleSingleModel: (b, m) =>
				handleSingleModelChat(b, m, clientRawRequest, request, apiKey, modelStr, onServe),
			comboName: modelStr,
			comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
			settings,
			comboCfg: {},
			request,
			sessionId: null,
			lastServed,
		})
	}

	return handleSingleModelChat(
		body,
		modelStr,
		clientRawRequest,
		request,
		apiKey,
		contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null,
	)
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(
	body,
	modelStr,
	clientRawRequest = null,
	request = null,
	apiKey = null,
	requestedModel = null,
	onServe = null,
): Promise<Response> {
	const clientFormat = request?.url
		? detectFormatByEndpoint(new URL(request.url).pathname, body)
		: null
	const responses = createErrorResponses(clientFormat)

	if (request?.signal?.aborted) return abortedResponse()

	const target = await resolveModelTarget(modelStr)

	// A model name that is really a combo: fan out over its members instead of
	// routing it as a provider/model pair.
	if (target.kind === "combo") {
		return runNestedCombo(body, modelStr, target.comboEntryName, target.comboModels, {
			clientRawRequest,
			request,
			apiKey,
			responses,
		})
	}
	if (target.kind === "unresolvable") {
		log.warn("CHAT", "Invalid model format", { model: modelStr })
		return responses.errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format")
	}

	const { provider, effectiveModel, modelMultipliers, isAntiProbe } = await resolveModelOverrides({
		modelStr,
		provider: target.provider,
		model: target.model,
		body,
	})
	const model = target.model

	// Routing shown in the unified "▶" line (client model → provider/model)

	// Extract userAgent from request
	const userAgent = request?.headers?.get("user-agent") || ""

	// What the caller may be told: an alias never names the model that served it.
	// Alias callers may omit it; derive from the alias the same way upstream does.
	requestedModel =
		requestedModel || (modelStr && modelStr !== `${provider}/${effectiveModel}` ? modelStr : null)
	const calledModel = requestedModel || `${provider}/${effectiveModel}`

	const chatSettings = await getSettings()
	const state = new FallbackState({
		request,
		provider,
		model,
		hideError: Boolean(chatSettings?.hideError),
		responses,
	})

	return runAccountFallbackLoop(state, {
		body,
		modelStr,
		requestedModel,
		calledModel,
		provider,
		model,
		effectiveModel,
		modelMultipliers,
		isAntiProbe,
		chatSettings,
		clientRawRequest,
		request,
		apiKey,
		userAgent,
		onServe,
	})
}

/**
 * Try which available accounts (fallback on errors).
 *
 * Each attempt lives in `tryNextAccount`; this loop only owns the two stops —
 * the caller going away before an attempt, and the ones an attempt decides (see
 * `AttemptOutcome`) — plus the single place a failed account is excluded, so the
 * opencode session rotation and the generic failure path cannot drift apart.
 */
async function runAccountFallbackLoop(
	state: FallbackState,
	attempt: Omit<AccountAttemptContext, "loop">,
): Promise<Response> {
	const { provider, model, request } = attempt
	const loop: AccountFallbackLoop = {
		state,
		rotatePastFailure: (failure) => {
			state.excludeConnectionIds.add(failure.connectionId)
			state.recordFailure(failure)
		},
	}

	while (true) {
		if (request?.signal?.aborted) {
			log.warn("CHAT", `Client disconnected before account fallback for ${provider}/${model}`)
			return state.responses.abortResponse()
		}
		const outcome = await tryNextAccount({ ...attempt, loop })
		if (outcome.kind === "return") return outcome.response
	}
}

/**
 * A studio calling into a combo may carry its own system prompt; it is applied
 * here because this branch returns before the override block.
 */
async function applyEntryStudioPrompt(body, modelStr: string, comboEntryName: string) {
	try {
		const { getStudioModel } = await import("@9router/db/repos/modelEditorRepo")
		const entryStudio = comboEntryName !== modelStr ? await getStudioModel(modelStr) : null
		if (entryStudio?.systemPrompt) {
			if (Array.isArray(body.messages)) {
				body.messages.unshift({ role: "system", content: entryStudio.systemPrompt })
			} else if (typeof body.system === "string") {
				body.system = entryStudio.systemPrompt + "\n\n" + body.system
			} else {
				body.system = entryStudio.systemPrompt
			}
		}
	} catch {
		/* fail open */
	}
}

/**
 * Run the combo a single-model attempt resolved to.
 *
 * Differs from the top-level combo in exactly two ways: members are attempted
 * with the raw model string (not the combo alias), and there is no `onServe`
 * to charge an empty answer to a connection.
 */
async function runNestedCombo(
	body,
	modelStr: string,
	comboEntryName: string,
	comboModels: string[],
	{
		clientRawRequest,
		request,
		apiKey,
		responses,
	}: {
		clientRawRequest: any
		request: Request | null
		apiKey: string | null
		responses: ReturnType<typeof createErrorResponses>
	},
): Promise<Response> {
	await applyEntryStudioPrompt(body, modelStr, comboEntryName)

	const chatSettings = await getSettings()
	// Check for combo-specific strategy first, fallback to global
	const comboStrategies = chatSettings.comboStrategies || {}
	const comboStrategy = resolveComboStrategy(comboEntryName, chatSettings)
	const requiredCapabilities = detectRequiredCapabilities(body)
	const comboCfg = comboStrategies[comboEntryName] || {}
	const keyAccess = await getKeyAccessContext(request)
	const nestedSessionId = comboSessionId({ request, body, apiKey })
	// Nested combo access remains constrained by this request's API key.
	const { augmentedModels, adapterAdded } = await resolveComboMembers({
		comboModels,
		requiredCapabilities,
		settings: chatSettings,
		keyAccess,
	})

	// Fusion members keep the pre-adapter panel; the caller drops tools/tool_choice
	// from the raw request for panel legs so a judge's tools never leak into them.
	const handlePanelMember = (b, m) =>
		handleSingleModelChat(b, m, clientRawRequest, request, apiKey, modelStr)
	const handleFusionMember = (b, m, isPanel) => {
		let cleanRawReq = clientRawRequest
		if (isPanel && clientRawRequest) {
			const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {}
			cleanRawReq = { ...clientRawRequest, body: cleanBody }
		}
		return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, comboEntryName)
	}

	return dispatchCombo({
		body,
		models: augmentedModels,
		comboModels,
		augmentedModels,
		adapterAdded,
		handleSingleModel: comboStrategy === "fusion" ? handleFusionMember : handlePanelMember,
		comboName: comboStrategy === "fusion" ? comboEntryName : modelStr,
		comboStrategy,
		settings: chatSettings,
		comboCfg,
		request,
		sessionId: nestedSessionId,
		withEmptyReporter: false,
	})
}
