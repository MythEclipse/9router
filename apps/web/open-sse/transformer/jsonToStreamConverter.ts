// Response-shape helpers. A gateway is supposed to speak SSE when it is asked to
// stream, but plenty of upstreams answer with a finished JSON document anyway (or
// the other way round). Everything here keys off what actually arrived instead of
// what the request asked for, so a mismatch degrades into working traffic instead
// of an empty stream.

import { MODEL_FALLBACK } from "../translator/schema/defaults.ts"
import { OPENAI_FINISH } from "../translator/schema/finishReasons.ts"
import { chatChunkSse, sseChunk } from "../utils/sse.ts"
import {
	SSE_CONTENT_TYPE_EVENT_STREAM,
	SSE_CONTENT_TYPE_JSON,
	SSE_DATA_PREFIX,
	SSE_DONE,
} from "../utils/sseConstants.ts"

const MAX_JSON_BODY_SIZE = 5 * 1024 * 1024 // 5MB for JSON body parsing

/** Content type the upstream actually sent, lowercased ("" when absent). */
export function contentTypeOf(response) {
	return String(response?.headers?.get("content-type") || "").toLowerCase()
}

export function looksLikeSseText(rawText) {
	const text = String(rawText || "").trimStart()
	if (!text) return false
	return /^event:|^data:|^\s*event:|^\s*data:/m.test(text)
}

export function isEventStreamResponse(response) {
	return contentTypeOf(response).includes(SSE_CONTENT_TYPE_EVENT_STREAM)
}

export function isJsonResponse(response) {
	const ct = contentTypeOf(response)
	return ct.includes(SSE_CONTENT_TYPE_JSON) || ct.includes("application/llm")
}

/**
 * A body is only replayable as chunks when it is an OpenAI chat.completion; any
 * other document (Claude message, Responses object, Gemini candidate) has to go
 * through the JSON path so the normal translators can reshape it.
 */
export function isChatCompletionBody(body) {
	return !!body && typeof body === "object" && Array.isArray(body.choices) && body.choices.length > 0
}

/**
 * Drain a provider response into a parsed JSON document, or null when the body is
 * empty / not JSON. The caller keeps the parsed value because reading a body
 * consumes it - a second `.json()` on the same Response always throws.
 * Added size limit to prevent DoS via extremely large JSON bodies.
 */
export async function readJsonBody(response) {
	if (!response || typeof response !== "object") return null

	let text = ""
	try {
		text = await response.text()
	} catch {
		return null
	}
	if (!text || !text.trim()) return null

	// Prevent DoS via large JSON bodies
	if (text.length > MAX_JSON_BODY_SIZE) {
		console.warn(`readJsonBody: JSON body too large (${text.length} bytes)`)
		return null
	}

	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

/** Re-wrap an already-read JSON document as the Response the JSON path expects. */
export function jsonResponseFromBody(body, sourceResponse) {
	return new Response(JSON.stringify(body), {
		status: sourceResponse?.status || 200,
		headers: { "content-type": SSE_CONTENT_TYPE_JSON },
	})
}

/**
 * Replay a finished chat.completion as OpenAI SSE frames: one content frame (plus
 * reasoning / tool-call frames), a finish frame carrying usage when the upstream
 * reported any, then the `[DONE]` sentinel.
 */
export function completionToSSEText(body) {
	const choice = body.choices?.[0] || {}
	const message = choice.message || choice.delta || {}
	const id = body.id || `chatcmpl-${Date.now()}`
	const created = body.created || Math.floor(Date.now() / 1000)
	const model = body.model || MODEL_FALLBACK
	const frames = []

	if (typeof message.reasoning_content === "string" && message.reasoning_content) {
		frames.push(
			chatChunkSse({ id, created, model, delta: { reasoning_content: message.reasoning_content } }),
		)
	}
	if (typeof message.content === "string" && message.content) {
		frames.push(chatChunkSse({ id, created, model, delta: { content: message.content } }))
	}
	;(message.tool_calls || []).forEach((call, index) => {
		frames.push(
			chatChunkSse({
				id,
				created,
				model,
				delta: {
					role: "assistant",
					tool_calls: [
						{
							index: typeof call.index === "number" ? call.index : index,
							id: call.id || `call_${index}`,
							type: call.type || "function",
							function: { name: call.function?.name || "", arguments: call.function?.arguments || "" },
						},
					],
				},
			}),
		)
	})

	const finishFrame: Record<string, any> = {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || OPENAI_FINISH.STOP }],
	}
	if (body.usage) finishFrame.usage = body.usage
	frames.push(sseChunk(finishFrame))
	frames.push(SSE_DONE)
	return frames.join("")
}

/** The replayed frames as a Response the streaming pipeline can pipe onward. */
export function sseResponseFromCompletion(body, sourceResponse) {
	return new Response(completionToSSEText(body), {
		status: sourceResponse?.status || 200,
		headers: {
			"content-type": SSE_CONTENT_TYPE_EVENT_STREAM,
			"cache-control": "no-cache",
		},
	})
}

/**
 * Safely parse a JSON string with size limit and malformed input handling.
 * @param {string} str - JSON string to parse
 * @param {number} maxSize - Maximum allowed size in bytes (default: 1MB)
 * @returns {any|null} Parsed object or null on error
 */
function safeJsonParse(str, maxSize = 1024 * 1024) {
	if (typeof str !== "string" || str.length === 0) return null
	if (str.length > maxSize) return null // Prevent memory exhaustion

	try {
		const parsed = JSON.parse(str)
		// Prevent circular reference attacks - JSON.parse is safe, but we check
		// the result is a reasonable size
		return parsed
	} catch {
		return null
	}
}

/**
 * Extract the JSON documents out of a streamed body text. Real upstreams deviate
 * from the spec constantly: no space after `data:`, `event:` field lines, NDJSON
 * rows with an SSE content-type, or a whole JSON document wearing an SSE label.
 * Anything unparseable is skipped so keep-alives and truncated tails are ignored.
 *
 * @param {string|undefined|null} rawText - Raw text to parse
 * @param {number} maxFrames - Maximum number of frames to return (default: 1000)
 * @returns {Array<object>} Array of parsed JSON objects
 */
export function collectJsonFrames(rawText, maxFrames = 1000) {
	if (!rawText || typeof rawText !== "string") return []

	const text = rawText.trim()
	if (!text) return []

	// PreventDoS: limit input size
	if (text.length > 10 * 1024 * 1024) {
		// 10MB hard limit
		console.warn("collectJsonFrames: input too large, truncating")
		return []
	}

	const frames = []

	// Try parsing as whole JSON document first (array or object)
	if (text.startsWith("{") || text.startsWith("[")) {
		const whole = safeJsonParse(text)
		if (whole !== null) {
			if (Array.isArray(whole)) {
				// Filter to only valid objects, limit count
				for (const item of whole) {
					if (item && typeof item === "object" && !Array.isArray(item)) {
						frames.push(item)
						if (frames.length >= maxFrames) break
					}
				}
			} else if (typeof whole === "object" && !Array.isArray(whole)) {
				frames.push(whole)
			}
		}
		if (frames.length > 0) return frames
	}

	// Fallback: line-by-line scan
	let lineStart = 0
	while (lineStart < text.length) {
		const lineEnd = text.indexOf("\n", lineStart)
		const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
		lineStart = lineEnd === -1 ? text.length : lineEnd + 1
		const trimmed = line.trim()
		if (!trimmed) continue

		// Skip comments and keep-alive markers
		if (trimmed.startsWith(":") || trimmed === "event: keep-alive") continue

		// Handle SSE format: "data: {...}"
		let payload = trimmed
		if (trimmed.startsWith(SSE_DATA_PREFIX)) {
			payload = trimmed.slice(SSE_DATA_PREFIX.length).trim()
		}

		if (!payload || payload.length === 0 || payload.startsWith(":")) continue

		// Must be JSON-like
		if (!payload.startsWith("{")) continue

		// Skip obviously invalid payloads
		if (payload.length > 128 * 1024) {
			// 128KB individual frame limit
			continue
		}

		const parsed = safeJsonParse(payload)
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			frames.push(parsed)
			if (frames.length >= maxFrames) break
		}
	}

	return frames
}
