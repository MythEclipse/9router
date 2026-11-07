// Global streaming tool-call bridge.
//
// Some OpenAI-shaped upstream responses do not all do
// function calling there: a DeepSeek model answers in the model's own DSML dialect inside
// `delta.content` (`<｜｜DSML｜｜ invoke name="Bash">…`), which the CodeBuddy IDE parses
// itself. A client of this gateway receives that markup as assistant text instead — on
// the Anthropic protocol a `text` block full of markers with `stop_reason: end_turn`, so
// no tool runs and the turn stalls.
//
// The bridge forwards the upstream SSE untouched until the accumulated text carries a
// DSML marker; from that frame on the reply is buffered and classified once at the end,
// so a declared call becomes `tool_calls` and the markup never travels. A request with no
// `tools`, a reply that never mentions DSML, and any non-SSE response pass straight
// through: the marker is the only trigger, and it is never legitimate prose.
//
// The parser is the DeepSeek one because the dialect is DeepSeek's — sloppy closers, both
// pipe widths and the scrubbing of leftover markers already live there.

import { chatChunkSse } from "../../utils/sse.ts"
import { SSE_DONE } from "../../utils/sseConstants.ts"
import { parseSSELine } from "../../utils/streamHelpers.ts"
import { parseDeepSeekToolCalls } from "../deepseekWebTools.ts"

const DSML_MARKER_RE = /(?:｜｜|\|\|?)DSML(?:｜｜|\|\|?)/i

/**
 * How much of the end of `text` cannot be forwarded yet: a DSML marker arrives token by token, so
 * the frames that carry `<｜`, then `｜DSML｜`, have already passed the client by the time the whole
 * marker is recognisable — and those fragments leak as assistant prose ahead of the tool call.
 * Hold back the longest tail that could still become a marker, and let it through otherwise.
 */
const MARKER_STAGES = new Set([
	"<",
	"<｜",
	"<｜｜",
	"<｜｜D",
	"<｜｜DS",
	"<｜｜DSM",
	"<｜｜DSML",
	"<｜｜DSML｜",
	"<｜｜DSML｜｜",
	"<|",
	"<||",
	"<||D",
	"<||DS",
	"<||DSM",
	"<||DSML",
	"<||DSML|",
	"<|DSML|",
])
/**
 * The longest tail of `text` that could still grow into a DSML marker: `<`, then `<｜`, `<｜｜DSML`,
 * the whole marker. Everything before it is prose and can be forwarded.
 */
function markerTail(text) {
	for (let n = Math.min(text.length, 12); n > 0; n -= 1) {
		if (MARKER_STAGES.has(text.slice(-n))) return n
	}
	return 0
}

const encoder = new TextEncoder()

interface StreamedReply {
	/** Every content delta seen so far, markup included. */
	text: string
	/** The part of `text` the client has already been sent. */
	forwarded: string
	id: string | null
	created: number
	model: string | null
}

interface Delta {
	content: string
	id: string | null
	created: number | null
	model: string | null
}

/** The content delta of one SSE frame, or null for frames that carry none. */
function deltaOf(frame: string): Delta | null {
	const line = frame.split("\n").find((candidate) => candidate.startsWith("data:"))
	if (!line) return null
	const payload = parseSSELine(line)
	const delta = payload?.choices?.[0]?.delta
	if (!delta) return null
	return {
		content: typeof delta.content === "string" ? delta.content : "",
		id: typeof payload?.id === "string" ? payload.id : null,
		created: typeof payload?.created === "number" ? payload.created : null,
		model: typeof payload?.model === "string" ? payload.model : null,
	}
}

/**
 * The closing frames of a buffered reply: the call it declared, or the prose that is left
 * once the markup is stripped. Only the prose the client has not seen yet is sent, and the
 * role frame only when nothing at all has been forwarded.
 */
function closingFrames(reply: StreamedReply, tools, idSeed: string): string {
	const parsed = parseDeepSeekToolCalls(reply.text, idSeed, tools)
	const calls = parsed.toolCalls ?? []
	const prose = parsed.content ?? ""
	const unseen = reply.forwarded
		? prose.startsWith(reply.forwarded)
			? prose.slice(reply.forwarded.length)
			: ""
		: prose
	const meta = {
		id: reply.id ?? `chatcmpl-${Date.now()}`,
		created: reply.created || Math.floor(Date.now() / 1000),
		model: reply.model ?? "codebuddy",
	}
	const frames: string[] = []
	if (!reply.forwarded) frames.push(chatChunkSse({ ...meta, delta: { role: "assistant" } }))
	if (unseen) frames.push(chatChunkSse({ ...meta, delta: { content: unseen } }))
	if (calls.length > 0) {
		calls.forEach((call, index) =>
			frames.push(chatChunkSse({ ...meta, delta: { tool_calls: [{ index, ...call }] } })),
		)
		frames.push(chatChunkSse({ ...meta, delta: {}, finishReason: "tool_calls" }))
	} else {
		frames.push(chatChunkSse({ ...meta, delta: {}, finishReason: "stop" }))
	}
	frames.push(SSE_DONE)
	return frames.join("")
}

/**
 * Rewrite a CodeBuddy response whose reply declares tools in DSML into one that declares
 * them as OpenAI `tool_calls`. Anything else is returned as it arrived.
 */
export function bridgeTextToolCalls(result, body, idSeed: string) {
	const tools = Array.isArray(body?.tools)
		? body.tools
		: Array.isArray(body?.functions)
			? body.functions.map((fn) => ({ type: "function", function: fn }))
			: []
	const response = result?.response
	if (tools.length === 0 || !response?.ok || !response.body) return result

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	const reply: StreamedReply = { text: "", forwarded: "", id: null, created: 0, model: null }
	let buffering = false
	let rest = ""
	let keepAlive: ReturnType<typeof setInterval> | null = null

	const stream = new ReadableStream({
		async start(controller) {
			const emit = (text: string) => controller.enqueue(encoder.encode(text))
			// Once DSML is detected the response must be buffered until its tool
			// envelope is complete. Keep the outer stream/watchdog active while the
			// model is still producing that envelope. SSE comments are invisible to
			// clients and are ignored by every response translator.
			keepAlive = setInterval(() => {
				if (buffering) emit(": 9router-stream-active\n\n")
			}, 15_000)
			// A marker arrives one token per frame (`<｜` then `｜DSML｜` …), so by the time the whole
			// marker is recognisable the frames before it have already been sent — and those
			// fragments leak to the client as prose. A frame that ENDS in a marker prefix is held
			// back instead; it is released as prose at the end if no marker ever completes.
			let held = ""
			const send = (frame: string) => {
				const lead = held
				held = ""
				return lead ? `${lead}\n\n${frame}\n\n` : `${frame}\n\n`
			}
			const absorb = (frame: string) => {
				const delta = deltaOf(frame)
				if (!delta) return
				reply.text += delta.content
				if (buffering) return
				if (delta.id) reply.id = delta.id
				if (delta.created) reply.created = delta.created
				if (delta.model) reply.model = delta.model
				if (DSML_MARKER_RE.test(reply.text)) buffering = true
			}
			const markForwarded = (frame: string) => {
				const delta = deltaOf(frame)
				if (delta) reply.forwarded += delta.content
			}
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					rest += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
					let cut = rest.indexOf("\n\n")
					while (cut !== -1) {
						const frame = rest.slice(0, cut)
						rest = rest.slice(cut + 2)
						absorb(frame)
						if (buffering) {
							held = ""
						} else if (markerTail(reply.text) > 0) {
							// The reply ends in what may still become a marker: keep the frame, and
							// fold it in if the next one completes the marker. Once buffering starts
							// the held frame is dropped — it was markup, not prose.
							held = held ? `${held}\n\n${frame}` : frame
						} else {
							emit(send(frame))
							markForwarded(frame)
						}
						cut = rest.indexOf("\n\n")
					}
				}
				if (rest.trim()) {
					absorb(rest)
					if (!buffering) {
						emit(send(rest))
						markForwarded(rest)
					}
				}
				// No marker completed: what was held was ordinary prose after all.
				if (held && !buffering) {
					// `held` is a complete SSE frame without the separator that was consumed
					// while buffering it. Restore the separator so the client dispatches the
					// final frame instead of treating it as an unterminated event.
					emit(`${held}\n\n`)
					held = ""
				}
				if (buffering) emit(closingFrames(reply, tools, idSeed))
			} catch (error) {
				const message = error?.message || ""
				const isAbort =
					error?.name === "AbortError" ||
					error?.code === "ABORT_ERR" ||
					message.includes("aborted") ||
					message.includes("cancelled")
				// A client cancellation is expected. Other reader failures must
				// reach pipeWithDisconnect so it can emit the configured terminal
				// error and release the request correctly.
				await reader.cancel().catch(() => {})
				if (!isAbort) {
					try {
						controller.error(error)
					} catch {
						/* consumer already closed */
					}
				}
			} finally {
				if (keepAlive) {
					clearInterval(keepAlive)
					keepAlive = null
				}
				try {
					controller.close()
				} catch {
					// The consumer already cancelled the stream.
				}
			}
		},
	})

	return {
		...result,
		response: new Response(stream, {
			status: response.status,
			headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
		}),
	}
}

// Backward-compatible name for callers and integrations that still refer to the
// original CodeBuddy-specific implementation.
export const bridgeCodebuddyToolCalls = bridgeTextToolCalls
