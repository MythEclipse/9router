/**
 * Does this client want a streamed answer?
 *
 * The two wire protocols disagree about the default. [OI] Chat Completions and
 * the Responses API treat an absent `stream` as false; the Anthropic Messages
 * API does too. 9router used to read absence as "stream" for every client,
 * which handed Claude callers an SSE body they then parsed as JSON — visible
 * downstream as a broken or empty answer rather than a clear error, since the
 * request itself succeeded with a 200.
 *
 * Only an explicit `true` opts a Claude client into SSE; every other format
 * keeps the previous `stream !== false` reading so nothing that relied on the
 * old behaviour moves.
 */
import { FORMATS } from "../translator/formats.ts"

export function prefersStreaming(sourceFormat: string, body: unknown): boolean {
	const stream = (body as { stream?: unknown } | null | undefined)?.stream
	if (sourceFormat === FORMATS.CLAUDE) return stream === true
	return stream !== false
}
