/**
 * Capture a finished stream so the prompt cache can replay it.
 *
 * The cache used to refuse `stream: true` outright, which excluded the requests that dominate an
 * agent workload. What made streamed answers hard to cache is that the useful artefact is not
 * the model's text — it is the *bytes the client received*, already translated into its format.
 * Synthesising those bytes from a final body would mean re-implementing each client format's
 * frame grammar; capturing them costs one pass-through tee.
 *
 * Two properties this must not break:
 *
 *  - **The bytes are forwarded untouched.** Each chunk is enqueued as it arrived; the capture is
 *    a decoder on the side, not a rewrite. A cache tap that re-encoded would corrupt a stream it
 *    was supposed to observe.
 *  - **Nothing is cached from a cancelled stream.** A client that hangs up mid-answer leaves a
 *    truncated capture, and storing it would replay a truncated answer to the next caller. The
 *    `flush` hook only runs when the stream ends normally.
 *
 * The capture is bounded (`MAX_CAPTURE_CHARS`): past the cap the tee stops accumulating and the
 * stream is left uncached, because a multi-megabyte row to save one request is a bad trade.
 */
import { saveStreamToSemanticCache } from "./semanticCache.ts"

/** How much of a stream is worth keeping, in characters. */
const MAX_CAPTURE_CHARS = 256 * 1024

export function tapStreamForCache(
	stream: ReadableStream<Uint8Array>,
	input: { body: unknown; model: string; provider: string },
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder()
	const capturedChunks: string[] = []
	let capturedLength = 0
	let overflowed = false
	let finished = false

	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				// Forward first: the client's latency must not depend on the capture.
				controller.enqueue(chunk)
				if (overflowed) return
				try {
					const decoded = decoder.decode(chunk, { stream: true })
					capturedLength += decoded.length
					if (capturedLength > MAX_CAPTURE_CHARS) {
						overflowed = true
						capturedChunks.length = 0
						return
					}
					if (decoded) capturedChunks.push(decoded)
				} catch {
					overflowed = true
					capturedChunks.length = 0
				}
			},
			flush() {
				if (overflowed || finished) return
				finished = true
				try {
					const decoded = decoder.decode()
					capturedLength += decoded.length
					if (capturedLength > MAX_CAPTURE_CHARS) return
					if (decoded) capturedChunks.push(decoded)
				} catch {
					return
				}
				saveStreamToSemanticCache(
					input.body,
					`${input.provider}/${input.model}`,
					capturedChunks.join(""),
				)
			},
		}),
	)
}
