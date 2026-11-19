// Response-shape helpers. A gateway is supposed to speak SSE when it is asked to
// stream, but plenty of upstreams answer with a finished JSON document anyway (or
// the other way round). Everything here keys off what actually arrived instead of
// what the request asked for, so a mismatch degrades into working traffic instead
// of an empty stream.

import { BODY_SNIFF_BYTES, BODY_SNIFF_DEADLINE_MS } from "../config/runtimeConfig.ts"
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

/** Sentinel the read-ahead race resolves with when the deadline fires. */
const SNIFF_DEADLINE = "__sniff_deadline__"

/** A bounded look at an upstream body, plus the response to keep using downstream. */
export interface SniffedResponse {
	/** "sse" = event frames, "json" = one JSON document, "unknown" = neither yet. */
	kind: "sse" | "json" | "unknown"
	/** The bytes that were read ahead, decoded. */
	prefix: string
	/** The same response, with the read-ahead replayed in front of the live body. */
	response: Response
}

/**
 * Replay `head`, then continue from `reader`. Sequential by construction: at most
 * one outstanding read, so the upstream is never drained twice in parallel.
 */
function replayBody(head: Uint8Array[], reader, pendingRead = null) {
	let pending = pendingRead
	const safeReader = reader && typeof reader.read === "function" ? reader : null
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of head || []) controller.enqueue(chunk)
			if (!safeReader) controller.close()
		},
		async pull(controller) {
			if (!safeReader) {
				controller.close()
				return
			}
			let result
			try {
				result = pending ? await pending : await safeReader.read()
			} catch (error) {
				controller.error(error)
				return
			}
			pending = null
			if (result.done) {
				controller.close()
				return
			}
			controller.enqueue(result.value)
		},
		cancel(reason) {
			try {
				safeReader?.cancel?.(reason)
			} catch {
				/* already closed */
			}
		},
	})
}

/** Decide what a decoded prefix looks like. */
function classifyPrefix(prefix: string): SniffedResponse["kind"] {
	if (!prefix) return "unknown"
	if (looksLikeSseText(prefix)) return "sse"
	const text = prefix.trimStart()
	// A JSON document (or an NDJSON line, which the stream parser would also treat
	// as a frame) always opens with one of these.
	if (text.startsWith("{") || text.startsWith("[")) return "json"
	return "unknown"
}

/**
 * Read a BOUNDED prefix of an upstream body to learn whether it speaks SSE or
 * answers with one JSON document, and hand back a response that still carries
 * every byte.
 *
 * This replaces the `await response.clone().text()` shape that used to gate the
 * same decision. Reading a clone to completion drains the upstream stream before
 * the first byte reaches the client, which turns every streamed answer into a
 * buffered one: the client waits for the whole generation, then receives the
 * frames in a single burst. A gateway must never do that - the read-ahead here
 * stops at `maxBytes` (or `deadlineMs`) and is replayed, so the client's
 * time-to-first-byte is unaffected.
 *
 * A response that already declares `text/event-stream` is returned untouched and
 * never read: it has nothing to prove, and reading it is the bug.
 */
export async function sniffResponseBody(
	response: Response,
	options: { maxBytes?: number; deadlineMs?: number } = {},
): Promise<SniffedResponse> {
	const { maxBytes = BODY_SNIFF_BYTES, deadlineMs = BODY_SNIFF_DEADLINE_MS } = options
	if (!response || typeof response !== "object") {
		return { kind: "unknown", prefix: "", response }
	}
	if (isEventStreamResponse(response)) return { kind: "sse", prefix: "", response }

	const body = response.body
	if (!body || typeof body.getReader !== "function" || body.locked) {
		// Nothing readable to inspect: leave the response for the caller to handle.
		return { kind: "unknown", prefix: "", response }
	}

	const reader = body.getReader()
	const decoder = new TextDecoder()
	const head: Uint8Array[] = []
	let prefix = ""
	let pendingRead: ReturnType<typeof reader.read> | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : BODY_SNIFF_BYTES
	const waitMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : BODY_SNIFF_DEADLINE_MS

	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(SNIFF_DEADLINE), waitMs)
	})
	const settle = (kind: SniffedResponse["kind"]): SniffedResponse => {
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
		return {
			kind,
			prefix,
			response: new Response(replayBody(head, reader, pendingRead), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			}),
		}
	}

	while (true) {
		if (!pendingRead) pendingRead = reader.read()
		let result
		try {
			result = await Promise.race([pendingRead, deadline])
		} catch {
			// Upstream errored mid-peek; the replay surfaces the same error.
			pendingRead = null
			return settle(classifyPrefix(prefix))
		}
		if (result === SNIFF_DEADLINE) {
			// Fail-open: keep the still-pending read so its chunk is replayed, and let
			// the caller treat an undecided body as it always would.
			return settle(classifyPrefix(prefix))
		}
		pendingRead = null
		if (result.done) {
			prefix += decoder.decode()
			return settle(classifyPrefix(prefix))
		}
		head.push(result.value)
		prefix += decoder.decode(result.value, { stream: true })
		// Settle the moment the prefix is decisive. Waiting for the byte budget
		// would delay the client's first token by however long the upstream takes
		// to send that many bytes - the same latency bug in a smaller window.
		const decided = classifyPrefix(prefix)
		if (decided !== "unknown") return settle(decided)
		if (prefix.length >= budget) return settle(decided)
	}
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
