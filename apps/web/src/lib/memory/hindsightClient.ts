/**
 * Hindsight HTTP client for the memory stage.
 *
 * Deliberately a plain `fetch` wrapper rather than `@vectorize-io/hindsight-client`:
 * this runs on the chat request path, and a dependency that pulls its own
 * transport would add to the cold-start of every route that imports `handleChat`.
 *
 * Three properties this module owns, because no caller can see them:
 *
 * 1. **Every call has a deadline.** A memory lookup that hangs is a chat request
 *    that hangs, so the `AbortController` fires whether or not the caller passed a
 *    signal. On timeout the caller gets `null` and continues without memory.
 * 2. **A dead service stops being asked.** `HINDSIGHT_CIRCUIT` opens after a few
 *    consecutive failures and short-circuits to `null` for a cooldown window. Without
 *    it, every request pays the full timeout while the service is down — the
 *    failure mode that turns one broken dependency into a slow gateway.
 * 3. **Nothing here throws.** Fail-open is the contract: `recall` and `retain` answer
 *    with a value or `null`, never with an exception, because the caller is a chat
 *    request that must not fail because a side service did.
 */

/** Consecutive failures before the breaker opens. */
const BREAKER_THRESHOLD = 3
/** How long the breaker stays open before one probe is allowed through. */
const BREAKER_COOLDOWN_MS = 30_000
/** Default per-call deadline: a recall must fit inside a chat turn's first byte. */
const DEFAULT_TIMEOUT_MS = 800

interface BreakerState {
	failures: number
	openUntil: number
}

/** Keyed by base URL: two configured Hindsight instances fail independently. */
const breakers = new Map<string, BreakerState>()

export interface HindsightRequestOptions {
	/** Per-call deadline in milliseconds. */
	timeoutMs?: number
	/** Caller's abort signal (client disconnected); aborts the upstream call too. */
	signal?: AbortSignal | null
	/** Label for the failure path, so a log line names the operation. */
	operation: string
}

export interface HindsightEndpoint {
	baseUrl: string
	/** Bearer token, when the deployment requires one. Never logged. */
	apiKey?: string | null
}

/** The state of the breaker for one endpoint — for the admin status route. */
export function hindsightBreakerState(baseUrl: string): {
	open: boolean
	failures: number
	retryInMs: number
} {
	const state = breakers.get(baseUrl)
	if (!state) return { open: false, failures: 0, retryInMs: 0 }
	const retryInMs = Math.max(0, state.openUntil - Date.now())
	return { open: retryInMs > 0, failures: state.failures, retryInMs }
}

function recordSuccess(baseUrl: string) {
	breakers.set(baseUrl, { failures: 0, openUntil: 0 })
}

function recordFailure(baseUrl: string) {
	const previous = breakers.get(baseUrl) ?? { failures: 0, openUntil: 0 }
	const failures = previous.failures + 1
	breakers.set(baseUrl, {
		failures,
		openUntil: failures >= BREAKER_THRESHOLD ? Date.now() + BREAKER_COOLDOWN_MS : 0,
	})
}

/** Test seam: forget every breaker so one case cannot leak into the next. */
export function resetHindsightBreakers() {
	breakers.clear()
}

/**
 * POST one Hindsight endpoint.
 *
 * Answers the parsed JSON body on 2xx, `null` on any other outcome — non-2xx,
 * timeout, abort, network error, or an open breaker. Nothing is thrown: the
 * caller is a chat request that must continue without memory.
 */
export async function postHindsight<T = unknown>(
	endpoint: HindsightEndpoint,
	path: string,
	payload: unknown,
	options: HindsightRequestOptions,
): Promise<T | null> {
	const result = await requestHindsight<T>(endpoint, path, options, {
		method: "POST",
		body: JSON.stringify(payload),
	})
	return result.ok ? result.data : null
}

/** GET one Hindsight endpoint, same fail-open contract. */
export async function getHindsight<T = unknown>(
	endpoint: HindsightEndpoint,
	path: string,
	options: HindsightRequestOptions,
): Promise<T | null> {
	const result = await requestHindsight<T>(endpoint, path, options, { method: "GET" })
	return result.ok ? result.data : null
}

/** DELETE one Hindsight endpoint, same fail-open contract. */
export async function deleteHindsight(
	endpoint: HindsightEndpoint,
	path: string,
	options: HindsightRequestOptions,
): Promise<boolean> {
	const result = await requestHindsight<unknown>(endpoint, path, options, { method: "DELETE" })
	return result.ok
}

/**
 * The one request path every verb shares, so the deadline, the breaker and the
 * "never throw" contract cannot drift between GET, POST and DELETE.
 *
 * The result distinguishes "succeeded with no body" (a 204 delete, a 202 retain)
 * from "did not succeed" — both would otherwise collapse into `null`, and a purge
 * that reported every delete as a failure is worse than one that reports none.
 */
async function requestHindsight<T>(
	endpoint: HindsightEndpoint,
	path: string,
	options: HindsightRequestOptions,
	init: { method: string; body?: string },
): Promise<{ ok: boolean; data: T | null }> {
	const { baseUrl, apiKey } = endpoint
	if (!baseUrl) return { ok: false, data: null }
	if (hindsightBreakerState(baseUrl).open) return { ok: false, data: null }

	const timeoutMs =
		typeof options.timeoutMs === "number" && options.timeoutMs > 0
			? options.timeoutMs
			: DEFAULT_TIMEOUT_MS
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	const onCallerAbort = () => controller.abort()
	if (options.signal) {
		if (options.signal.aborted) controller.abort()
		else options.signal.addEventListener("abort", onCallerAbort, { once: true })
	}

	try {
		const headers: Record<string, string> = {}
		if (init.body !== undefined) headers["Content-Type"] = "application/json"
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
			method: init.method,
			headers,
			body: init.body,
			signal: controller.signal,
		})
		if (!response.ok) {
			recordFailure(baseUrl)
			return { ok: false, data: null }
		}
		recordSuccess(baseUrl)
		// A retain answered with 202/204 has no body to parse.
		const text = await response.text()
		return { ok: true, data: text ? (JSON.parse(text) as T) : null }
	} catch {
		recordFailure(baseUrl)
		return { ok: false, data: null }
	} finally {
		clearTimeout(timer)
		if (options.signal) options.signal.removeEventListener("abort", onCallerAbort)
	}
}
