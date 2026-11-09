import { dbg, isDebugEnabled } from "./debugLog.ts"
import { buildSafeErrorMessage, MAX_TOTAL_STREAM_BYTES } from "./streamHandler.ts"

export function createStallWatchdog({
	streamController,
	stallTimeoutMs,
}: {
	streamController
	stallTimeoutMs: number
}) {
	const tag = "STREAM"
	let stallTimer = null
	let chunkCount = 0
	let totalBytes = 0
	let lastChunkAt = Date.now()
	// Reason handed to the terminal builder: set to "stream stall timeout" /
	// "stream exceeded maximum size limit" when the watchdog itself terminates.
	let abortMessage = "upstream connection lost"
	const t0 = Date.now()
	let streamErrored = false

	// Clear stall timer safely
	const clearStall = () => {
		if (stallTimer) {
			clearTimeout(stallTimer)
			stallTimer = null
		}
	}

	// Arm stall timer with validation
	const armStall = () => {
		clearStall()
		if (streamErrored) return

		stallTimer = setTimeout(() => {
			stallTimer = null
			if (streamErrored) return

			abortMessage = "stream stall timeout"
			const detail = {
				phase: "upstream stall",
				stallTimeoutMs,
				chunks: chunkCount,
				totalBytes,
				sinceLastMs: Date.now() - lastChunkAt,
				status: streamController?.provider || "unknown",
			}
			dbg(
				tag,
				`STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`,
			)
			streamController.handleError?.(
				new Error(`stream stall timeout: ${detail.chunks} chunks, ${detail.totalBytes} bytes`),
			)
			streamController.abort?.()
			streamErrored = true
		}, stallTimeoutMs)
	}

	// Cleanup function for all termination paths
	const cleanupStream = () => {
		clearStall()
		streamErrored = true
	}

	const stats = () => `chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`

	// Wrap controller so every termination path clears the stall timer.
	const terminate = {
		signal: streamController.signal,
		startTime: streamController.startTime,
		provider: streamController.provider,
		model: streamController.model,
		isConnected: () => streamController.isConnected(),
		handleComplete: () => {
			dbg(tag, `complete | ${stats()}`)
			cleanupStream()
			streamController.handleComplete()
		},
		handleError: (e) => {
			const safeMsg = buildSafeErrorMessage(e)
			dbg(tag, `error: ${safeMsg} | ${stats()}`)
			cleanupStream()
			streamController.handleError(e)
		},
		handleDisconnect: (r) => {
			dbg(tag, `disconnect: ${r} | ${stats()}`)
			cleanupStream()
			streamController.handleDisconnect(r)
		},
		abort: () => {
			clearStall()
			streamErrored = true
			streamController.abort()
		},
	}

	// Single pass over each upstream chunk: size guard, byte/gap accounting, rearm.
	const tap = new TransformStream({
		transform(chunk, controller) {
			if (streamErrored) return // Stop processing if stream has errored

			chunkCount++
			const sz = chunk?.byteLength || chunk?.length || 0

			// Check total bytes limit
			totalBytes += sz
			if (totalBytes > MAX_TOTAL_STREAM_BYTES) {
				cleanupStream()
				abortMessage = "stream exceeded maximum size limit"
				streamController.handleError?.(
					new Error(`stream too large: ${totalBytes} bytes > ${MAX_TOTAL_STREAM_BYTES}`),
				)
				streamController.abort?.()
				return
			}

			const now = Date.now()
			const gap = now - lastChunkAt
			lastChunkAt = now

			// Log periodically for debugging
			if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
				dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`)
			}

			armStall()
			controller.enqueue(chunk)
		},
		flush() {
			dbg(tag, `upstream EOF | ${stats()}`)
			cleanupStream()
		},
	})

	return {
		tap,
		terminate,
		armStall,
		cleanupStream,
		/** Why the watchdog last terminated the stream (abort reason for the terminal builder). */
		abortReason: () => abortMessage,
	}
}
