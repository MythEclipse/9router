/**
 * The proxy-test endpoint answers one question — "does this proxy URL actually reach that URL?" —
 * and the interesting part is what it answers when the answer is no.
 *
 * - **The failure status belongs to the probe, not to us.** A proxy that answers `407 Proxy
 *   Authentication Required` is telling the operator something precise. Flattening that into a
 *   `500` ("our server broke") sends them to look at the wrong machine.
 * - **Only a probe that reported no status at all becomes a 500.** That is the one case where
 *   nothing upstream said anything, so the failure genuinely is ours.
 * - **A timeout is not a 500 either.** An aborted probe is a result: the proxy did not answer in
 *   time, which is exactly what the operator wanted to find out.
 *
 * This module holds those verdicts as named things so the route reads as prose. The probe itself
 * (`testProxyUrl`) stays where it is — it owns sockets and undici, and neither belongs here.
 */

/** What a completed probe reports. Every field is optional because the probe is a network call. */
export interface ProxyProbeResult {
	readonly ok?: boolean
	readonly status?: number
	readonly statusText?: string
	readonly url?: string
	readonly elapsedMs?: number
	readonly error?: string
}

/** What the route answers: a body and the status to send it with. */
export interface ProxyProbeAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

const PROBE_FAILURE_FALLBACK_STATUS = 500
const PROBE_FAILURE_FALLBACK_MESSAGE = "Proxy test failed"

/**
 * The status to report for a probe that did not succeed.
 *
 * A numeric `status` on the result is passed through untouched — including `407`, `403` and `502`,
 * because each of those names a different upstream problem and a probe that hides them is useless.
 */
export function proxyProbeFailureStatus(result: ProxyProbeResult | null | undefined): number {
	const status = result?.status
	return typeof status === "number" ? status : PROBE_FAILURE_FALLBACK_STATUS
}

/** Turn a probe result into the response the route sends. */
export function proxyProbeAnswer(result: ProxyProbeResult | null | undefined): ProxyProbeAnswer {
	if (result?.ok) return { status: 200, body: { ...result } }
	return {
		status: proxyProbeFailureStatus(result),
		body: { ok: false, error: result?.error || PROBE_FAILURE_FALLBACK_MESSAGE },
	}
}

/**
 * The message for a probe that threw instead of returning.
 *
 * `AbortError` is the probe's own timeout firing, so it gets the sentence the operator expects
 * rather than the platform's "The operation was aborted".
 */
export function proxyProbeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "AbortError" ? "Proxy test timed out" : error.message
	}
	return String(error)
}
