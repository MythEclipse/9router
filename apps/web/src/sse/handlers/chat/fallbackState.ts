import {
	GENERIC_FALLBACK_BUDGET_MS,
	OPENCODE_FALLBACK_BUDGET_MS,
} from "open-sse/config/errorConfig"
import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import * as log from "../../utils/logger.ts"
import type { ChatErrorResponses } from "./responses.ts"

/**
 * Per-request proxy fallback state, keyed by `request` then provider.
 *
 * Nested attempts of ONE request (a combo member re-entering the handler, a
 * retry loop) share this object so the pool exclusions and the wall-clock
 * deadline cannot be restarted by re-entering: a retry loop cannot restart
 * the clock.
 */
interface ProxyFallbackState {
	excludePoolIds: Set<string>
	deadlineMs: number | null
	lastError: string | null
	lastStatus: number | null
	lastHeaders: Record<string, string> | null
}

const requestProxyFallbacks = new WeakMap<object, Map<string, ProxyFallbackState>>()

function newProxyState(): ProxyFallbackState {
	return {
		excludePoolIds: new Set(),
		deadlineMs: null,
		lastError: null,
		lastStatus: null,
		lastHeaders: null,
	}
}

export function getRequestProxyFallbackState(request, provider): ProxyFallbackState {
	if (!request || typeof request !== "object") return newProxyState()
	let providerStates = requestProxyFallbacks.get(request)
	if (!providerStates) {
		providerStates = new Map()
		requestProxyFallbacks.set(request, providerStates)
	}
	let state = providerStates.get(provider)
	if (!state) {
		state = newProxyState()
		providerStates.set(provider, state)
	}
	return state
}

/** One failed attempt, as the account/proxy fallback loop sees it. */
export interface AttemptFailure {
	/** The connection that failed (excluded by the loop, not by this state). */
	connectionId: string
	/** The proxy pool the connection used, if any; excluded by `recordFailure`. */
	proxyPoolId?: string | null
	status?: number | null
	error?: string | null
	/** `upstreamResponseHeaders(...)` of the failed upstream response. */
	headers?: Record<string, string> | null
}

/** Which exclusions the budget-spent line reports (identical to its historical wording). */
interface BudgetSpentParts {
	/** Report the proxy-pool count. */
	pools?: boolean
	/** Report the excluded-account count. */
	accounts?: boolean
}

/**
 * The state one account-fallback loop carries across its attempts.
 *
 * It owns BOTH kinds of exclusion — connections (account fallback) and proxy
 * pools (proxy fallback) — so a single `recordFailure` keeps them in step, and
 * the last upstream failure, including the one that ends a request, is readable
 * from one place.
 */
export class FallbackState {
	readonly provider: string
	readonly model: string
	readonly proxy: ProxyFallbackState
	readonly excludeConnectionIds = new Set<string>()
	readonly hideError: boolean
	/**
	 * How many account attempts this loop has started. The budget below is a
	 * wall-clock deadline, so on its own it cannot tell "we are out of time"
	 * apart from "the first attempt ate all the time" — and the loop stopped on
	 * the second reading, reporting a rotation it never ran. Counting attempts
	 * lets `shouldStopForBudget` guarantee at least one rotation.
	 */
	private attemptsStarted = 0
	/**
	 * Response builders bound to the client format. The single-model path sets
	 * them to the builders bound to `request.url` rather than the array form.
	 */
	responses: ChatErrorResponses
	/**
	 * Free-tier session rotation only opens new quota windows: when the client
	 * aborts (probe budget spent, user cancelled), every proxy is answering the
	 * same spent-quota 429 and more attempts cannot help, so stop instead of
	 * burning the pool dry past the caller's deadline.
	 *
	 * The budget applies to EVERY provider, not just opencode. Gating the check on
	 * the provider left non-opencode traffic rotating accounts with no wall-clock
	 * bound at all: N accounts x connect timeout compounded without limit, so a
	 * provider with many dead credentials could hold a request open far past the
	 * caller's patience. opencode keeps the longer budget; it also seeds the
	 * deadline across the nested attempts of ONE request (`??=`), so a retry loop
	 * cannot restart the clock.
	 */
	readonly deadlineMs: number

	constructor({
		request,
		provider,
		model,
		hideError,
		responses,
	}: {
		request: Request | null
		provider: string
		model: string
		hideError: boolean
		responses: ChatErrorResponses
	}) {
		this.provider = provider
		this.model = model
		this.hideError = hideError
		this.responses = responses
		this.proxy = getRequestProxyFallbackState(request, provider)
		const fallbackBudgetMs =
			provider === "opencode" ? OPENCODE_FALLBACK_BUDGET_MS : GENERIC_FALLBACK_BUDGET_MS
		this.deadlineMs = this.proxy.deadlineMs ??= Date.now() + fallbackBudgetMs
	}

	get excludePoolIds(): Set<string> {
		return this.proxy.excludePoolIds
	}

	/** Last upstream error, from this loop or an earlier attempt of this request. */
	get lastError(): string | null {
		return this.proxy.lastError
	}

	get lastStatus(): number | null {
		return this.proxy.lastStatus
	}

	/** Exclusions from this loop and from earlier attempts of this request. */
	get exhausted(): boolean {
		return this.excludeConnectionIds.size === 0 && this.proxy.excludePoolIds.size === 0
	}

	/**
	 * Exclude the failed connection's proxy pool (proxy fallback) and remember the
	 * failure; the connection itself is excluded by the caller's loop.
	 */
	recordFailure(failure: AttemptFailure): void {
		const failedPoolId = failure.proxyPoolId
		if (failedPoolId) this.proxy.excludePoolIds.add(failedPoolId)
		this.proxy.lastError = failure.error ?? null
		this.proxy.lastStatus = failure.status ?? null
		this.proxy.lastHeaders = failure.headers ?? null
	}

	/** True once the caller's budget is gone. Only meaningful after a failure. */
	budgetSpent(): boolean {
		return Date.now() >= this.deadlineMs
	}

	/**
	 * Record that an attempt is about to start. Called from the top of the
	 * attempt, before the credential is picked, so the count reflects attempts
	 * that really happened rather than ones the loop considered.
	 */
	noteAttemptStarted(): void {
		this.attemptsStarted += 1
	}

	/** How many attempts this loop has started (0 before the first). */
	get attemptCount(): number {
		return this.attemptsStarted
	}

	/**
	 * Only stop once an attempt has actually failed: a first attempt that is
	 * slow to start is not the same thing as an exhausted rotation.
	 *
	 * The deadline alone was not enough. It is a wall clock, and one slow attempt
	 * can outlast the whole budget by itself — antigravity answers a spent quota
	 * after ~47s against a 25s generic budget, so the very first failure looked
	 * like an exhausted rotation and the loop returned it without ever trying the
	 * second account. The line still said "→ NEXT PROXY/ACCOUNT", which made a
	 * skipped rotation read like a performed one.
	 *
	 * So a rotation is always given one chance: while fewer than two attempts have
	 * started, the budget cannot stop the loop. Past that the deadline governs
	 * again, which is what bounds a provider with many dead credentials.
	 */
	shouldStopForBudget(): boolean {
		if (!this.proxy.lastError) return false
		if (this.attemptsStarted < 2) return false
		return this.budgetSpent()
	}

	/** Log the single "budget spent" line, for whichever caller shape saw it. */
	logBudgetSpent({ accounts, pools }: BudgetSpentParts = {}): void {
		const parts: string[] = []
		if (pools) parts.push(`${this.proxy.excludePoolIds.size} proxy pools`)
		if (accounts) parts.push(`${this.excludeConnectionIds.size} accounts`)
		log.warn(
			"FALLBACK",
			`⏱ fallback budget spent for ${this.provider}/${this.model} after ${parts.join(" / ")} — returning last error`,
		)
	}

	/** Last error as an error response, mirroring whatever the loop last saw. */
	lastErrorResponse(): Response {
		return this.responses.errorResponse(
			this.proxy.lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
			this.proxy.lastError || "All accounts unavailable",
			this.proxy.lastHeaders,
			this.hideError,
		)
	}
}
