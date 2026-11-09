/** Combo response helpers. */
import { extractTextContent } from "../translator/formats/gemini.ts"
import { isNoRetryFinish, peekStreamForContent, reconstructStream } from "./emptyFailover.ts"

// Peek a 2xx combo response for real content. Returns null for non-SSE responses (leave
// them untouched). For SSE, returns { outcome: "content"|"empty", finishReason, response }
// where `response` is a faithful replay of the original stream (head buffer + live reader).
export async function peekComboResponse(result, log, sourceFormat) {
	const ct = (result.headers.get("content-type") || "").toLowerCase()
	if (!result.body || !ct.includes("text/event-stream")) return null
	// The Responses API carries event names in `event:` lines while the JSON
	// payload may omit `type`. Pass the SSE event through to the structural parser.
	const peeked = await peekStreamForContent(result.body, { format: sourceFormat })
	if (peeked?.error) {
		log?.warn?.("COMBO", "peekStreamForContent could not inspect SSE body", {
			stage: "peekStreamForContent",
			status: result.status,
			bodyLocked: !!result.body?.locked,
			hasReader: typeof result.body?.getReader === "function",
			error: peeked.error?.message || String(peeked.error),
			stack: peeked.error?.stack,
		})
	}
	const response = new Response(reconstructStream(peeked.head, peeked.reader, peeked.pendingRead), {
		status: result.status,
		statusText: result.statusText,
		headers: result.headers,
	})
	return {
		outcome: peeked.outcome,
		finishReason: peeked.finishReason,
		timedOut: peeked.timedOut,
		response,
	}
}

export function isLockedStreamError(error) {
	const msg = String(error?.message || error || "")
	return /ReadableStream is locked|Invalid state: The ReadableStream is locked|stream.*locked/i.test(
		msg,
	)
}

/**
 * Sleep that resolves early when `signal` aborts, so a disconnect is noticed
 * during a cooldown wait instead of after it.
 */
export function sleepAbortable(ms, signal) {
	if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms))
	if (signal.aborted) return Promise.resolve<void>(undefined)
	return new Promise<void>((resolve) => {
		const timer = setTimeout(finish, ms)
		function finish() {
			clearTimeout(timer)
			signal.removeEventListener("abort", finish)
			resolve()
		}
		signal.addEventListener("abort", finish, { once: true })
	})
}

/**
 * Tell the host that a member answered 2xx with no usable content.
 *
 * Fail-open on purpose: bookkeeping must never turn a recoverable empty answer
 * into a thrown error that aborts the whole combo.
 */
export async function reportEmptyResponse(onEmptyResponse, modelStr, reason) {
	if (typeof onEmptyResponse !== "function") return
	try {
		await onEmptyResponse(modelStr, reason)
	} catch {
		/* telemetry only */
	}
}

// Deep-copy the request body so translator in-place mutations (tool_use/tool_result
// reshaping, role rewriting) don't leak across combo fallback iterations or parallel
// panel calls. Covers: OpenAI/Claude `messages`, Gemini `contents`, Responses `input`.
export function deepCopyBody(body) {
	if (!body || typeof body !== "object") return body
	// structuredClone copies to full depth, which the hand-rolled version did not:
	// it only cloned ONE level of `messages`/`contents`/`input`, so `tool_calls`
	// inside a message, nested `parts`, and every non-array parameter (`tools`,
	// `metadata`, generation settings) stayed shared by reference across combo
	// iterations and parallel fusion panels — the exact leak this function exists
	// to prevent. Both Bun and Node provide it; fall back only if absent.
	if (typeof structuredClone === "function") {
		try {
			return structuredClone(body)
		} catch {
			/* non-cloneable payload (e.g. a stream): use the shallow path */
		}
	}
	const copyItem = (m) => ({
		...m,
		content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content,
	})
	const copyContentsItem = (m) => ({
		...m,
		parts: Array.isArray(m.parts) ? m.parts.map((b) => ({ ...b })) : m.parts,
	})
	const copyInputItem = (m) => ({
		...m,
		content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content,
	})
	return {
		...body,
		...(Array.isArray(body.messages) ? { messages: body.messages.map(copyItem) } : {}),
		...(Array.isArray(body.contents) ? { contents: body.contents.map(copyContentsItem) } : {}),
		...(Array.isArray(body.input) ? { input: body.input.map(copyInputItem) } : {}),
	}
}

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: "
const TOOL_RESULT_PREFIX = "[Tool result: "

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
export function flattenToolHistory(messages) {
	return messages
		.filter((msg) => msg)
		.map((msg) => {
			if (msg.role === "tool" || msg.role === "function") {
				return {
					role: "assistant",
					content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]`,
				}
			}
			if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
				const { tool_calls, ...rest } = msg
				const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ")
				const base =
					extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "")
				return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` }
			}
			if (Array.isArray(msg.content)) {
				const hasToolUse = msg.content.some((c) => c.type === "tool_use")
				const hasToolResult = msg.content.some((c) => c.type === "tool_result")
				if (hasToolUse || hasToolResult) {
					const textParts = []
					const toolNames = []
					const toolResults = []
					for (const block of msg.content) {
						if (block.type === "text" && block.text) textParts.push(block.text)
						if (block.type === "tool_use") toolNames.push(block.name || "tool")
						if (block.type === "tool_result")
							toolResults.push(extractTextContent(block.content) || String(block.content ?? ""))
					}
					const { ...rest } = msg
					let newContent = textParts.join("\n")
					if (toolNames.length > 0) {
						newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`
					}
					if (toolResults.length > 0) {
						newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`
					}
					return { ...rest, content: newContent }
				}
			}
			return msg
		})
}
/**
 * Detect whether a 2xx JSON response contains zero usable content
 * (e.g. empty assistant message with in_progress/incomplete)
 * so combo fallback can continue to the next model.
 */
export function isZeroContentResponse(data) {
	if (!data || typeof data !== "object") return false

	// OpenAI chat format
	if (Array.isArray(data.choices)) {
		if (data.choices.length === 0) return true
		const choice = data.choices[0]
		if (!choice) return true

		const msg = choice.message || choice.delta
		const content = msg?.content
		const hasContent =
			typeof content === "string"
				? content.trim().length > 0
				: Array.isArray(content) && content.length > 0
		const hasToolCalls =
			(Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg?.function_call)
		const hasReasoning =
			typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim().length > 0 : false

		const finish = choice.finish_reason
		const isNormalFinish =
			finish === "stop" || finish === "length" || finish === "tool_calls" || finish === "function_call"

		if (
			!hasContent &&
			!hasToolCalls &&
			!hasReasoning &&
			(!isNormalFinish || finish === "in_progress" || finish === "incomplete")
		) {
			return true
		}
	}

	// Anthropic messages format
	if (Array.isArray(data.content)) {
		const hasContent = data.content.some(
			(c) => (c.type === "text" && c.text?.trim().length > 0) || c.type === "tool_use",
		)
		const stopReason = data.stop_reason
		if (!hasContent && (!stopReason || stopReason === "in_progress" || stopReason === "incomplete")) {
			return true
		}
	}

	return false
}
