/**
 * A minimal reader for a `text/event-stream` body consumed chunk by chunk.
 *
 * The install-progress endpoints stream one `event:`/`data:` frame per step, and
 * the UI has to turn them back into typed updates while the body is still
 * arriving. Doing that inline means every caller re-implements the frame split,
 * and the usual bugs come with the copy: a frame cut in half by a chunk boundary
 * is parsed as two broken frames, a trailing frame without its blank line is
 * dropped, and a malformed `data:` line silently swallows the whole frame.
 *
 * This reader buffers the partial tail so a frame is only emitted once its
 * terminating blank line has arrived, and it reports a malformed `data:` line as
 * a frame with `data: null` rather than hiding it — the caller decides whether
 * that is fatal.
 */

/** One parsed frame from the stream. */
export interface ServerSentFrame {
	/** The `event:` field, or `progress` when the frame carried none. */
	event: string
	/** The parsed JSON payload, or `null` when the frame had no usable data. */
	data: Record<string, unknown> | null
}

/** The default event name for a frame that carries none. */
export const DEFAULT_FRAME_EVENT = "progress"

/** Split a buffer into complete frames plus whatever tail is still incomplete. */
function splitFrames(buffer: string): { frames: string[]; tail: string } {
	const parts = buffer.split("\n\n")
	const tail = parts.pop() ?? ""
	return { frames: parts, tail }
}

/**
 * Parse one raw frame.
 *
 * The last `data:` line wins, matching the SSE spec's per-field reassignment and
 * the behaviour the inline copies had. A frame with no data (a comment, a
 * keep-alive) yields `data: null`; a frame whose data is not valid JSON also
 * yields `null` so the caller can skip it.
 */
export function parseFrame(rawFrame: string): ServerSentFrame {
	let event = DEFAULT_FRAME_EVENT
	let data: Record<string, unknown> | null = null

	for (const line of rawFrame.split("\n")) {
		if (line.startsWith("event: ")) {
			event = line.slice("event: ".length).trim()
			continue
		}
		if (line.startsWith("data: ")) {
			try {
				const parsed = JSON.parse(line.slice("data: ".length))
				// Only an object is a usable payload; a bare number or string is a
				// malformed frame for every caller of this helper.
				data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
			} catch {
				data = null
			}
		}
	}

	return { event, data }
}

/**
 * Feed a chunk into the reader and get back every frame it completed.
 *
 * Construct once per response and call `push` for each decoded chunk; call
 * `flush` after the stream ends to drain a final frame that arrived without its
 * blank-line terminator.
 */
export class ServerSentFrameReader {
	private buffer = ""

	/** Add a decoded chunk and return the frames it completed. */
	push(chunk: string): ServerSentFrame[] {
		this.buffer += chunk
		const { frames, tail } = splitFrames(this.buffer)
		this.buffer = tail
		return frames.map(parseFrame)
	}

	/** Emit any frame left in the buffer after the body ended. */
	flush(): ServerSentFrame[] {
		const remaining = this.buffer
		this.buffer = ""
		if (!remaining.trim()) return []
		return [parseFrame(remaining)]
	}
}
