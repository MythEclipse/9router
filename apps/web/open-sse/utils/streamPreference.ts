/**
 * Does this client want a streamed answer?
 *
 * Every protocol that carries an explicit `stream` field defaults it to false:
 * Chat Completions, the Responses API, and the Anthropic Messages API. 9router
 * used to read an absent field as "stream" for all of them, so a caller that
 * never asked for SSE received `text/event-stream` and parsed it as JSON —
 * visible downstream as a broken or empty answer rather than a clear error,
 * because the request itself succeeded with a 200.
 *
 * Only an explicit `true` opts those clients into SSE. Formats whose streaming
 * is decided by the endpoint rather than a body field (Gemini, Antigravity)
 * keep the previous `stream !== false` reading, since they have no `stream` to
 * send and a false default would silently un-stream them.
 */
import { FORMATS } from "../translator/formats.ts"

const STREAM_FIELD_FORMATS = new Set([FORMATS.CLAUDE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])

export function prefersStreaming(sourceFormat: string, body: unknown): boolean {
	const stream = (body as { stream?: unknown } | null | undefined)?.stream
	if (STREAM_FIELD_FORMATS.has(sourceFormat)) return stream === true
	return stream !== false
}
