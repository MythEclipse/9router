// Stream handler with disconnect detection - shared for all providers
import { MAX_STREAM_BYTES_PER_REQUEST, STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.ts"
import { dbg, isDebugEnabled } from "./debugLog.ts"
import { createStallWatchdog } from "./streamStall.ts"
import { formatClockTime } from "./timeFormat.ts"

export const MAX_TOTAL_STREAM_BYTES = MAX_STREAM_BYTES_PER_REQUEST || 100 * 1024 * 1024 // 100MB default
const _STALL_CHECK_INTERVAL_MS = 1000 // Check stall every second

// Get HH:MM:SS timestamp
function getTimeString() {
	return formatClockTime()
}

/** Callbacks and identity carried by a stream controller. */
export interface StreamControllerOptions {
	/** Invoked when the client goes away, with the disconnect reason. */
	onDisconnect?: (info: { reason: string; duration: number }) => void
	onError?: (error: Error) => void
	log?: {
		line?: (tag: string, symbol: string, message: string) => void
		errorLine?: (tag: string, symbol: string, message: string) => void
	}
	provider?: string
	model?: string
	reqTag?: string
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({
	onDisconnect,
	onError,
	log,
	provider,
	model,
	reqTag = "",
}: StreamControllerOptions = {}) {
	const abortController = new AbortController()
	const startTime = Date.now()
	let disconnected = false
	let abortTimeout = null

	// Only abnormal terminations are logged; normal completion is covered by "📊 done".
	// isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
	const logStream = (symbol, status, isError = false) => {
		const duration = Date.now() - startTime
		const emit = isError ? log?.errorLine : log?.line
		if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`)
		else
			console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`)
	}

	return {
		signal: abortController.signal,
		startTime,
		provider: provider || "unknown",
		model: model || "unknown",

		isConnected: () => !disconnected,

		// Call when client disconnects
		handleDisconnect: (reason = "client_closed") => {
			if (disconnected) return
			disconnected = true

			// Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
			// socket on every completed request. "📊 done" is the authoritative outcome line.
			dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`)

			// Delay abort to allow cleanup
			abortTimeout = setTimeout(() => {
				abortController.abort()
			}, 500)

			onDisconnect?.({ reason, duration: Date.now() - startTime })
		},

		// Call when stream completes normally (no line here - "📊 done" is authoritative)
		handleComplete: () => {
			if (disconnected) return
			disconnected = true

			if (abortTimeout) {
				clearTimeout(abortTimeout)
				abortTimeout = null
			}
		},

		// Call on error
		handleError: (error) => {
			if (disconnected) return
			disconnected = true

			if (abortTimeout) {
				clearTimeout(abortTimeout)
				abortTimeout = null
			}

			if (error.name === "AbortError") {
				logStream("⚡", "ABORTED")
				return
			}

			logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true)
			onError?.(error)
		},

		abort: () => abortController.abort(),
	}
}

// ---------------------------------------------------------------------------
// Shared classifiers - one place that decides what a stream failure *means*
// ---------------------------------------------------------------------------

/** Closed/unusable consumer state surfaced by a ReadableStreamDefaultController. */
const CONTROLLER_CLOSED_MESSAGE_MARKERS = ["already closed", "Invalid state"]

/** Transport-level failures that mean "the other end went away", not "we broke". */
const NETWORK_CLOSE_MESSAGE_MARKERS = [
	"aborted",
	"socket hang up",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
]
const NETWORK_CLOSE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"])

interface StreamErrorClassification {
	/** Transport reset / abort / hang-up - treat as a graceful close. */
	isNetworkClose: boolean
	/** The downstream controller was already closed - do not report it as a stream error. */
	isControllerClosed: boolean
	/** Whether the stream controller should be told about the error. */
	shouldError: boolean
}

/**
 * Classify an error thrown while reading/piping a stream.
 *
 * `wasConnected` is the controller's connection state at the moment of the
 * failure: a disconnect means a teammate path already owns the reporting, so
 * the error is not reported again.
 */
function classifyStreamError(
	error,
	{ wasConnected = true }: { wasConnected?: boolean } = {},
): StreamErrorClassification {
	const msg = String(error?.message || "")
	const code = error?.code || error?.cause?.code || ""
	const isNetworkClose =
		error?.name === "AbortError" ||
		NETWORK_CLOSE_MESSAGE_MARKERS.some((marker) => msg.includes(marker)) ||
		NETWORK_CLOSE_CODES.has(code)
	const isControllerClosed = CONTROLLER_CLOSED_MESSAGE_MARKERS.some((marker) => msg.includes(marker))
	return { isNetworkClose, isControllerClosed, shouldError: wasConnected && !isControllerClosed }
}

/**
 * Why an upstream body cannot be piped, or null when it can.
 * `locked` is reported separately because it is a caller bug, not an outage.
 */
function bodyUnavailableReason(body): "missing" | "locked" | null {
	if (!body) return "missing"
	if (typeof body.getReader !== "function") return "missing"
	if (body.locked) return "locked"
	return null
}

/**
 * Validate and sanitize stream response metadata
 * @param {object} response - Response object
 * @returns {boolean} Whether response is valid for streaming
 */
function isValidStreamResponse(response) {
	if (!response || typeof response !== "object") return false
	if (!response.body || typeof response.body.getReader !== "function") return false
	if (!response.headers || typeof response.headers.get !== "function") return false
	return true
}

/**
 * Build a safe error message that doesn't leak sensitive information
 * @param {Error|string} error - Error or error message
 * @returns {string} Safe error message
 */
export function buildSafeErrorMessage(error) {
	const msg = typeof error === "string" ? error : error?.message || "Unknown stream error"
	// Remove any potential sensitive information (API keys, tokens, paths)
	return msg
		.replace(/(?:sk|pk)_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
		.replace(/authorization:\s*[^\s]/gi, "authorization: [REDACTED]")
}

/**
 * Render terminal bytes for an aborted stream. `message` is the human-readable
 * reason; the return value (if any) is enqueued as the closing frame.
 */
export type AbortTerminalBuilder = (message: string) => Uint8Array | string | null | undefined

/**
 * Best-effort teardown of the reader and (optional) writer.
 * There is no writer when the source was a bare readable - nothing to abort.
 */
function releaseStreamEnds(reader, writer) {
	try {
		reader?.cancel?.()?.catch?.(() => {})
	} catch {
		/* already released */
	}
	try {
		writer?.abort?.()?.catch?.(() => {})
	} catch {
		/* already released */
	}
}

/** Enqueue terminal bytes onto `controller`; enqueue failures (closed/cancelled consumer) are ignored. */
function enqueueTerminal(controller, bytes) {
	if (!bytes) return
	try {
		controller.enqueue(bytes)
	} catch {
		/* the consumer already closed/cancelled the stream */
	}
}

/** Emit terminal bytes then close. The close is swallowed if the consumer already left. */
function emitTerminalThenClose(controller, bytes) {
	enqueueTerminal(controller, bytes)
	try {
		controller.close()
	} catch {
		/* already closed or cancelled */
	}
}

/**
 * Single terminal-emitter: synthesize the stream's closing frame (if a builder
 * is configured), then close. Returns whether terminal bytes were emitted;
 * `terminalEmitted` is the caller's once-only guard - a second call is a no-op
 * so a stream never carries two closing frames.
 */
function terminateStream(
	controller,
	onAbortTerminal: AbortTerminalBuilder | null,
	message: string,
	terminalEmitted: { done: boolean },
): boolean {
	if (terminalEmitted.done || !onAbortTerminal) return false
	terminalEmitted.done = true
	let bytes = null
	try {
		bytes = onAbortTerminal(message)
	} catch {
		/* terminal emission is best-effort only */
	}
	emitTerminalThenClose(controller, bytes)
	return true
}

/**
 * A stream that emits the terminal payload (if any) and is immediately done.
 * Used by the pre-pipe bail-outs, where there is nothing left to stream.
 */
function buildClosedTerminalStream(
	onAbortTerminal: AbortTerminalBuilder | null = null,
	reason = "upstream stream closed",
) {
	return new ReadableStream({
		start(controller) {
			// Emit the terminal frame (when a builder exists), then close. The close is
			// unconditional: a start() that never closes leaves the consumer hanging.
			const terminalEmitted = { done: false }
			terminateStream(controller, onAbortTerminal, reason, terminalEmitted)
			if (!terminalEmitted.done) {
				try {
					controller.close()
				} catch {
					/* already closed or cancelled */
				}
			}
		},
	})
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here - output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * Accepts either a bare ReadableStream or a `{ readable, writable }` pair
 * (backward compatible). A writer is optional: when the source is a plain
 * readable there is nothing to abort upstream, so teardown is a no-op.
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 */
export function createDisconnectAwareStream(
	transformStream,
	streamController,
	onAbortTerminal = null,
) {
	const readable = transformStream?.readable || transformStream
	const writer = transformStream?.writable?.getWriter?.() || null
	const reader = readable.getReader()
	const providerName = streamController?.provider || "unknown"
	const modelName = streamController?.model || "unknown"
	const terminalEmitted = { done: false }

	return new ReadableStream({
		async pull(controller) {
			if (!streamController.isConnected()) {
				dbg(
					"STREAM",
					`pull skipped | disconnected=true | provider=${providerName} | model=${modelName}`,
				)
				// Once-only terminal; falls through to close when there is no builder.
				terminateStream(controller, onAbortTerminal, "client disconnected", terminalEmitted)
				try {
					controller.close()
				} catch {
					/* already closed or cancelled */
				}
				return
			}

			try {
				const { done, value } = await reader.read()

				if (done) {
					dbg("STREAM", `transform reader done | provider=${providerName} | model=${modelName}`)
					streamController.handleComplete()
					controller.close()
					return
				}
				controller.enqueue(value)
			} catch (error) {
				const wasConnected = streamController.isConnected()
				const msg0 = error?.message || ""
				const { isNetworkClose, isControllerClosed, shouldError } = classifyStreamError(error, {
					wasConnected,
				})
				dbg(
					"STREAM",
					`transform pull failed | provider=${providerName} | model=${modelName} | connected=${wasConnected} | locked=${msg0.includes("locked")} | reason=${msg0}`,
				)
				if (shouldError) streamController.handleError(error)
				releaseStreamEnds(reader, writer)

				// Graceful close on network/abort, or when a structured terminal is available
				// (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
				if (!wasConnected || isNetworkClose || onAbortTerminal) {
					terminateStream(controller, onAbortTerminal, msg0 || "stream closed", terminalEmitted)
					try {
						controller.close()
					} catch (_e) {
						/* already closed or cancelled */
					}
				} else if (!isControllerClosed) {
					// A closed consumer is expected; anything else is a real stream error.
					try {
						controller.error(error)
					} catch (_e) {
						/* already closed or cancelled */
					}
				}
			}
		},

		cancel(reason) {
			dbg(
				"STREAM",
				`cancelled | provider=${providerName} | model=${modelName} | reason=${String(reason || "cancelled")}`,
			)
			streamController.handleDisconnect(reason || "cancelled")
			releaseStreamEnds(reader, writer)
		},
	})
}

/**
 * Stall watchdog + byte accounting for a piped upstream stream.
 *
 * Stall detection tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * Returns the upstream tap (counts bytes + arms the watchdog) and a
 * `terminate` controller that clears the watchdog on every termination path.
 */
export function safePipeResponseBody(
	response,
	transformStream,
	{ context = "response", onError = null } = {},
) {
	const body = response?.body
	const unavailable = bodyUnavailableReason(body)

	if (unavailable) {
		const reason = unavailable === "locked" ? "upstream body already locked" : "upstream body missing"
		const err = new TypeError(`${context} pipe skipped: ${reason}`)
		onError?.(err)
		return buildClosedTerminalStream(null, reason)
	}

	try {
		return body.pipeThrough(transformStream)
	} catch (error) {
		onError?.(error)
		return buildClosedTerminalStream(null, error?.message || "stream pipe failed")
	}
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Pipeline: validate → stall watchdog → upstream tap → transform → disconnect wrapper.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(
	providerResponse,
	transformStream,
	streamController,
	onAbortTerminal: AbortTerminalBuilder | null = null,
	stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
) {
	const tag = "STREAM"

	// Validate response before processing
	if (!isValidStreamResponse(providerResponse)) {
		const reason = "invalid stream response"
		const _err = new TypeError(`stream pipe skipped: ${reason}`)
		dbg(tag, `pipe skip | reason=${reason}`)
		streamController?.handleDisconnect?.(reason)
		return buildClosedTerminalStream(onAbortTerminal, reason)
	}

	const contentType = providerResponse?.headers?.get?.("content-type") || "unknown"
	const body = providerResponse?.body

	if (bodyUnavailableReason(body)) {
		const reason = "upstream body already locked"
		const _err = new TypeError(`stream pipe skipped: ${reason} | contentType=${contentType}`)
		dbg(
			tag,
			`pipe skip | reason=${reason} | status=${providerResponse?.status || "unknown"} | contentType=${contentType}`,
		)
		streamController?.handleDisconnect?.(reason)
		return buildClosedTerminalStream(onAbortTerminal, reason)
	}

	const {
		tap: upstreamTap,
		terminate,
		armStall,
		cleanupStream,
		abortReason,
	} = createStallWatchdog({
		streamController,
		stallTimeoutMs,
	})

	armStall()
	dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`)

	let transformedBody
	try {
		transformedBody = providerResponse.body.pipeThrough(upstreamTap).pipeThrough(transformStream)
	} catch (error) {
		cleanupStream()
		const safeMsg = buildSafeErrorMessage(error)
		dbg(tag, `pipeThrough failed: ${safeMsg}`)
		streamController?.handleError?.(error)
		return buildClosedTerminalStream(onAbortTerminal, safeMsg)
	}

	// Pass the transformed readable (not a fake writable) and the watchdog-wrapped
	// controller; the terminal builder receives the watchdog's abort reason so a
	// stall surfaces as "stream stall timeout".
	return createDisconnectAwareStream(
		transformedBody,
		terminate,
		onAbortTerminal ? () => onAbortTerminal(abortReason()) : null,
	)
}
