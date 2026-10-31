/**
 * Hold an admission slot for as long as the request is actually running.
 *
 * The gate existed and enforced nothing: `GET /api/queue` read a gate instance that no request
 * ever entered, so `inFlight` was always 0, `meanServiceMs` was always `null`, and the
 * `Retry-After` it reported was always `null` too. The batch runner used a different instance,
 * so the bound applied to batches and to nothing else.
 *
 * Why a wrapper instead of a call inside the handler: a streamed answer outlives its `Response`
 * object. `run()` settles when the response is *built*, which for a stream is the moment the
 * first byte is available — releasing there would free the slot while the upstream call is still
 * generating. So the slot is taken before the handler and handed back by the stream's own
 * `flush` (normal end) or `cancel` (client hung up) hook.
 *
 * A full queue is a 429 with `Retry-After`, which is what the gate's own refusal carries. The
 * alternative — letting it throw through the handler — would surface as a 500, and a client
 * cannot back off from a 500.
 */
import { AppError } from "9router-api/domain/errors"

/** The refusal a saturated gateway answers with. */
function tooBusy(retryAfterSeconds: number, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type: "rate_limit_error" } }), {
		status: 429,
		headers: {
			"Content-Type": "application/json",
			"Retry-After": String(Math.max(1, Math.round(retryAfterSeconds))),
		},
	})
}

/**
 * The gate, or `null` when the use-case graph could not be built.
 *
 * A gateway whose graph is broken should still answer: the alternative is that every `/v1`
 * request fails with a 500 about a component the caller never asked for. The error is logged
 * once per process, loudly, because a silently ungated gateway is also a problem.
 */
let graphFailureLogged = false

async function admissionGate() {
	try {
		const { getUseCases } = await import("@/lib/useCases")
		return getUseCases().admission
	} catch (error) {
		if (!graphFailureLogged) {
			graphFailureLogged = true
			console.error(
				"[admission] use-case graph unavailable; requests are ungated:",
				error instanceof Error ? error.message : error,
			)
		}
		return null
	}
}

/** Release the slot when the body finishes, is cancelled, or fails. */
function holdSlotUntilBodyEnds(response: Response, release: () => void): Response {
	if (!response.body) {
		release()
		return response
	}
	const reader = response.body.getReader()
	let released = false
	const releaseOnce = () => {
		if (released) return
		released = true
		release()
	}
	// Hand-built rather than `pipeThrough`, because a cancelled consumer never runs a
	// `TransformStream`'s `flush`: the slot would stay taken until the process restarted.
	const held = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done) {
					releaseOnce()
					controller.close()
					return
				}
				controller.enqueue(value)
			} catch (error) {
				releaseOnce()
				controller.error(error)
			}
		},
		async cancel(reason) {
			releaseOnce()
			await reader.cancel(reason)
		},
	})
	return new Response(held, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

/**
 * Run `handler` while holding one admission slot.
 *
 * `null` when the gateway is saturated — the caller returns the 429 it was given.
 */
export async function withAdmission(handler: () => Promise<Response>): Promise<Response> {
	// Imported here, not at module scope: this wrapper is loaded by every `/v1` route, and a
	// static import would drag the whole use-case graph (and the database handle) into any
	// module that merely mentions the route — a test harness included.
	const gate = await admissionGate()
	if (!gate) return handler()

	let release: () => void
	try {
		release = await gate.acquire()
	} catch (error) {
		if (error instanceof AppError) {
			const data = (error.data ?? {}) as { retryAfterSeconds?: number }
			return tooBusy(data.retryAfterSeconds ?? 1, error.message)
		}
		// An unknown failure in the gate must not take the gateway down with it: the request is
		// passed through ungated rather than refused for a reason nobody can act on.
		return handler()
	}

	let response: Response
	try {
		response = await handler()
	} catch (error) {
		release()
		throw error
	}
	return holdSlotUntilBodyEnds(response, release)
}
