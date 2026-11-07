import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import { handleChatCore } from "open-sse/handlers/chatCore"
import { getProjectIdForConnection } from "open-sse/services/projectId"
import { detectFormatByEndpoint } from "open-sse/translator/formats"
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders"
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect"
import { appendPxpipeEvent } from "@/lib/pxpipe/events"
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader"
import {
	clearAntigravityStrikes,
	handleAntigravityQuotaError,
} from "../../services/antigravityQuota.ts"
import {
	clearAccountError,
	getProviderCredentials,
	markAccountUnavailable,
} from "../../services/auth.ts"
import { checkAndRefreshToken, updateProviderCredentials } from "../../services/tokenRefresh.ts"
import * as log from "../../utils/logger.ts"

import type { ChatCoreFailure, ChatCoreResult } from "./chatCoreResult.ts"
import type { AttemptFailure, FallbackState } from "./fallbackState.ts"

/**
 * The caller's loop, passed in so the exclusion of a failed account stays at
 * exactly one site (see `runAccountFallbackLoop` in `chat.ts`).
 */
export interface AccountFallbackLoop {
	state: FallbackState
	/** Exclude the failed account — and its proxy pool — before the next attempt. */
	rotatePastFailure: (failure: AttemptFailure) => void
}

/**
 * What every attempt of one request shares; none of it changes between attempts.
 */
export interface AccountAttemptContext {
	/** The loop this attempt runs under; also carries the fallback state. */
	loop: AccountFallbackLoop
	body: any
	/** The combo name (or model string) the caller asked for. */
	modelStr: string
	/** What the caller may be told: an alias never names the serving model. */
	requestedModel: string | null
	/** The name quoted back to the caller in "no credentials"/"all rate limited" errors. */
	calledModel: string
	/** Pre-computed routing identity (overrides already applied). */
	provider: string
	model: string
	effectiveModel: string
	modelMultipliers: any
	isAntiProbe: boolean
	chatSettings: any
	clientRawRequest: any
	request: Request | null
	apiKey: string | null
	userAgent: string
	/** Announced before serving, so a combo can charge an empty answer correctly. */
	onServe?: ((modelStr: string, credentials: any) => void) | null
}

/**
 * What one attempt did: either keep rotating, or hand this response back.
 */
export interface AttemptOutcome {
	kind: "continue" | "return"
	response?: Response
	lastError?: string | null
}

/**
 * OpenCode free quota is tracked per session id (upstream #5107): a 429
 * FreeUsageLimitError means this session window is spent, so the canonical
 * session must be burned and the retry re-enter the proxy loop with a fresh one
 * instead of hammering the same burned session through every proxy.
 *
 * Exported so the session-rotation invariant is testable without a live
 * upstream: only opencode's `free usage limit` 429 takes this path.
 */
export function isOpencodeFreeUsageSpent(
	provider: string,
	status?: number | null,
	error?: string | null,
) {
	return provider === "opencode" && status === 429 && /free\s*usage\s*limit/i.test(error || "")
}

/**
 * `handleChatCore` call for one credential, in the grouped option form: one
 * group per concern (client identity, token savers, semantic cache, stream,
 * hooks) instead of the ~50 flat knobs the handler used to take.
 */
async function runChatCore(
	ctx: AccountAttemptContext,
	credentials,
	refreshedCredentials,
): Promise<ChatCoreResult> {
	const { body, provider, model, effectiveModel, requestedModel, chatSettings } = ctx
	const providerThinking = (chatSettings.providerThinking || {})[provider] || null
	const result: ChatCoreResult = await handleChatCore({
		body: { ...body, model: `${provider}/${effectiveModel}` },
		modelInfo: { provider, model: effectiveModel },
		credentials: refreshedCredentials,
		log,
		// Grouped options: each group owns one concern. `normalizeChatCoreOptions`
		// still folds a flat caller, but this call site is the one that must show
		// the shape new code should use.
		stream: { clientSignal: ctx.request?.signal },
		client: {
			requestedModel,
			modelMultipliers: ctx.modelMultipliers,
			isAntiProbe: ctx.isAntiProbe,
			hideError: Boolean(chatSettings.hideError),
			clientRawRequest: ctx.clientRawRequest,
			connectionId: credentials.connectionId,
			userAgent: ctx.userAgent,
			apiKey: ctx.apiKey,
			ccFilterNaming: !!chatSettings.ccFilterNaming,
			providerThinking,
			// Undefined means on: the fallback is opt-out so a malformed tool payload
			// never reaches the caller, and `toolCallFallback: false` restores the
			// previous pass-the-error-through behaviour.
			toolCallFallbackEnabled: chatSettings.toolCallFallback !== false,
			// Per-provider user overrides (custom headers / connect timeout) from settings
			providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
			// Detect source format by endpoint + body
			sourceFormatOverride: ctx.request?.url
				? detectFormatByEndpoint(new URL(ctx.request.url).pathname, body)
				: null,
		},
		semanticCache: {
			enabled: Boolean(chatSettings.semanticCacheEnabled),
			ttlHours: chatSettings.semanticCacheTtlHours ?? 3,
			maxEntries: chatSettings.semanticCacheMaxEntries ?? 1000,
		},
		tokenSavers: {
			rtkEnabled: Boolean(chatSettings.rtkEnabled),
			contextPruningEnabled: Boolean(chatSettings.contextPruningEnabled),
			maxMessagesLimit: Number(chatSettings.maxMessagesLimit) || 20,
			contextPruningLevel: chatSettings.contextPruningLevel || "full",
			headroomEnabled: Boolean(chatSettings.headroomEnabled),
			headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
			headroomCompressUserMessages: Boolean(chatSettings.headroomCompressUserMessages),
			headroomTimeoutMs: chatSettings.headroomTimeoutMs,
			cavemanEnabled: Boolean(chatSettings.cavemanEnabled),
			cavemanLevel: chatSettings.cavemanLevel || "full",
			ponytailEnabled: Boolean(chatSettings.ponytailEnabled),
			ponytailLevel: chatSettings.ponytailLevel || "full",
			customPromptEnabled: Boolean(chatSettings.customPromptEnabled),
			customPrompt: chatSettings.customPrompt || "",
			pxpipeEnabled: Boolean(chatSettings.pxpipeEnabled),
			pxpipeMinChars: chatSettings.pxpipeMinChars,
			pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
			// Lazily warms the in-process module on first use; null when not installed (fail-open)
			pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
			onPxpipeEvent: appendPxpipeEvent,
		},
		hooks: {
			onCredentialsRefreshed: async (newCreds) => {
				await updateProviderCredentials(credentials.connectionId, {
					...newCreds,
					existingProviderSpecificData: credentials.providerSpecificData,
					testStatus: "active",
				})
			},
			onRequestSuccess: async () => {
				await clearAccountError(credentials.connectionId, credentials, model, provider)
				// "Consecutive" strikes: a success clears the breaker for this pair.
				clearAntigravityStrikes(credentials.connectionId, model)
			},
		},
	})
	return result
}

/**
 * One account attempt: pick a credential, run the request, and decide whether
 * the loop keeps rotating.
 *
 * The two fallback mechanisms meet here but stay separate: account fallback
 * excludes the connection, proxy fallback excludes its pool (and the pool
 * exclusion survives across nested attempts inside `FallbackState`).
 */
export async function tryNextAccount(ctx: AccountAttemptContext): Promise<AttemptOutcome> {
	const state = ctx.loop.state
	const { provider, model, modelStr, request } = ctx

	if (state.shouldStopForBudget()) {
		state.logBudgetSpent({ accounts: true, pools: true })
		return { kind: "return", response: state.lastErrorResponse() }
	}

	const credentials: any = await getProviderCredentials(
		provider,
		state.excludeConnectionIds,
		model,
		{
			requestedModel: ctx.requestedModel || model,
			excludePoolIds: state.excludePoolIds,
		},
	)

	// Announce which account is about to serve `modelStr` so the combo's
	// empty-response report can be attributed to the right connection.
	if (credentials && !credentials.allRateLimited && typeof ctx.onServe === "function") {
		ctx.onServe(modelStr, credentials)
	}

	// All accounts unavailable
	if (!credentials || credentials.allRateLimited) {
		return noCredentialsOutcome(ctx, credentials)
	}

	// Account selection shown in the unified "▶" line (acc:...)
	const refreshedCredentials = await checkAndRefreshToken(provider, credentials)

	// Ensure real project ID is available for providers that need it (P0 fix: cold miss)
	if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
		const pid = await getProjectIdForConnection(
			credentials.connectionId,
			refreshedCredentials.accessToken,
			provider,
		)
		if (pid) {
			refreshedCredentials.projectId = pid
			// Persist to DB in background so subsequent requests have it immediately
			updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => {})
		}
	}

	const result = await runChatCore(ctx, credentials, refreshedCredentials)
	if (result.success) return { kind: "return", response: result.response }

	// chatCore returns one of two shapes; a `success: false` result is always the
	// error envelope, so the failure arm is the only one reachable from here.
	const failure = result as ChatCoreFailure

	// Antigravity 409/429: refresh live quota to get exact resetAt before locking
	let quotaResetMs = null
	let resetsAtMs = failure.resetsAtMs
	if (provider === "antigravity" && (failure.status === 409 || failure.status === 429)) {
		quotaResetMs = await handleAntigravityQuotaError(
			credentials.connectionId,
			failure.status,
			model,
			refreshedCredentials.accessToken,
			credentials.providerSpecificData,
		)
		if (quotaResetMs) resetsAtMs = quotaResetMs
	}

	const proxyPoolId = credentials.providerSpecificData?.connectionProxyPoolId || null
	const failureHeaders = upstreamResponseHeaders(failure.response?.headers)

	// A spent free-tier session: rotate it, then keep rotating accounts/pools.
	// Carries the same deadline as the generic failure path below: past the
	// caller's budget every further proxy answers the same spent-quota 429 into
	// a void, so hand back the last error now.
	if (isOpencodeFreeUsageSpent(provider, failure.status, failure.error)) {
		return await rotateOpencodeSessionForAttempt(ctx, credentials, refreshedCredentials, failure, {
			proxyPoolId,
			headers: failureHeaders,
		})
	}

	// Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
	// Do not persist a modelLock_* for this path.
	const shouldFallback =
		provider === "antigravity" && quotaResetMs
			? true
			: (
					await markAccountUnavailable(
						credentials.connectionId,
						failure.status ?? 0,
						failure.error ?? "",
						provider,
						model,
						resetsAtMs,
						{
							excludePoolIds: state.excludePoolIds,
							proxyPoolId,
						},
					)
				).shouldFallback

	if (shouldFallback) {
		log.warn(
			"FALLBACK",
			`⇄ ACC:${credentials.connectionName} UNAVAILABLE (${failure.status}) → NEXT PROXY/ACCOUNT`,
		)
		ctx.loop.rotatePastFailure({
			connectionId: credentials.connectionId,
			proxyPoolId,
			status: failure.status ?? null,
			error: failure.error ?? null,
			headers: failureHeaders,
		})
		// The probe carries its own AbortSignal, but the fallback loop holds no
		// reference to it: past the caller's deadline every further proxy answers
		// the same spent-quota 429 into a void, so hand back the last error now.
		if (state.budgetSpent()) {
			state.logBudgetSpent({ accounts: true })
			return { kind: "return", response: failure.response }
		}
		return { kind: "continue" }
	}

	return { kind: "return", response: failure.response }
}

/**
 * Burn the spent session (upstream #5107), exclude the account it served and
 * rotate.
 */
async function rotateOpencodeSessionForAttempt(
	ctx: AccountAttemptContext,
	credentials,
	refreshedCredentials,
	failure: ChatCoreFailure,
	proxy: { proxyPoolId: string | null; headers: Record<string, string> | null },
): Promise<AttemptOutcome> {
	try {
		const { rotateOpencodeSession } = await import("open-sse/executors/opencode")
		rotateOpencodeSession(refreshedCredentials)
	} catch {
		/* a failed rotation must not block the fallback */
	}
	log.warn(
		"FALLBACK",
		`⇄ ACC:${credentials.connectionName} SESSION ROTATED (free quota spent) → NEXT PROXY/ACCOUNT`,
	)
	ctx.loop.rotatePastFailure({
		connectionId: credentials.connectionId,
		proxyPoolId: proxy.proxyPoolId,
		status: failure.status ?? null,
		error: failure.error ?? null,
		headers: proxy.headers,
	})
	if (ctx.loop.state.budgetSpent()) {
		ctx.loop.state.logBudgetSpent({ accounts: true })
		return { kind: "return", response: failure.response }
	}
	return { kind: "continue" }
}

/**
 * Nothing left to try: report whichever of the three exhaustion shapes applies.
 */
async function noCredentialsOutcome(
	ctx: AccountAttemptContext,
	credentials: any,
): Promise<AttemptOutcome> {
	const state = ctx.loop.state
	const { provider, model, chatSettings } = ctx

	if (credentials?.allRateLimited) {
		const errorMsg = state.lastError || credentials.lastError || "Unavailable"
		const status = HTTP_STATUS.SERVICE_UNAVAILABLE
		log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`)
		return {
			kind: "return",
			response: state.responses.unavailableResponse(
				status,
				`[${ctx.calledModel}] ${errorMsg}`,
				credentials.retryAfter,
				credentials.retryAfterHuman,
			),
		}
	}

	if (state.exhausted) {
		log.warn("AUTH", `No active credentials for provider: ${provider}`)
		// 400, matching every other modality handler (see
		// unavailableCredentialResponse in accountFallbackLoop). This used to be
		// 404 while chat-completions' siblings answered 400, so a client that
		// treats 404 as "do not retry" and 400 as "fix the request" got two
		// different contracts for the same condition depending on the endpoint.
		return {
			kind: "return",
			response: state.responses.errorResponse(
				HTTP_STATUS.BAD_REQUEST,
				`No credentials are serving ${ctx.calledModel} right now`,
			),
		}
	}

	log.warn("CHAT", "No more accounts or proxy pools available", { provider })
	const { hideError } = chatSettings || {}
	try {
		const { recordErrorLog } = await import("@/lib/localDb")
		recordErrorLog({
			provider,
			model,
			endpoint: "chat",
			statusCode: state.lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
			errorMessage: state.lastError || "All accounts unavailable",
			errorType: "account_exhausted",
		})
	} catch {
		/* fail open */
	}
	// Status/headers/hint as last produced by an attempt; the deployment's
	// `hideError` setting decides whether the upstream text reaches the caller.
	return {
		kind: "return",
		response: state.responses.errorResponse(
			state.lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
			state.lastError || "All accounts unavailable",
			state.proxy.lastHeaders,
			Boolean(hideError),
		),
	}
}
