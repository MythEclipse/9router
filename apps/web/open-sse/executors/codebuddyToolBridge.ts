// CodeBuddy tool-call bridge.
//
// CodeBuddy's gateway is OpenAI-compatible, but the models behind it do not all do
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

import { parseDeepSeekToolCalls } from "../translator/deepseekWebTools.ts"
import { chatChunkSse } from "../utils/sse.ts"
import { SSE_DONE } from "../utils/sseConstants.ts"
import { parseSSELine } from "../utils/streamHelpers.ts"

const DSML_MARKER_RE = /(?:｜｜|\|\|?)DSML(?:｜｜|\|\|?)/i

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
export function bridgeCodebuddyToolCalls(result, body, idSeed: string) {
	const tools = Array.isArray(body?.tools) ? body.tools : []
	const response = result?.response
	if (tools.length === 0 || !response?.ok || !response.body) return result
	const contentType = response.headers?.get?.("content-type") || ""
	if (!contentType.includes("event-stream")) return result

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	const reply: StreamedReply = { text: "", forwarded: "", id: null, created: 0, model: null }
	let buffering = false
	let rest = ""

	const stream = new ReadableStream({
		async start(controller) {
			const emit = (text: string) => controller.enqueue(encoder.encode(text))
			// Text keeps accumulating once buffering starts — only forwarding stops.
			const absorb = (frame: string) => {
				const delta = deltaOf(frame)
				if (!delta) return
				reply.text += delta.content
				if (buffering) return
				reply.forwarded += delta.content
				if (delta.id) reply.id = delta.id
				if (delta.created) reply.created = delta.created
				if (delta.model) reply.model = delta.model
				if (DSML_MARKER_RE.test(reply.text)) buffering = true
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
						if (!buffering) emit(`${frame}\n\n`)
						cut = rest.indexOf("\n\n")
					}
				}
				if (rest.trim()) {
					absorb(rest)
					if (!buffering) emit(rest)
				}
				if (buffering) emit(closingFrames(reply, tools, idSeed))
			} catch {
				// Client gone: stop pulling the upstream instead of leaving it open.
				await reader.cancel().catch(() => {})
			} finally {
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
