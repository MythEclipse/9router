/**
 * Web search — streaming injection of Anthropic's block pair.
 *
 * Two situations produce the blocks:
 *
 *  1. **passthrough lane** — the upstream ran the search itself and already
 *     streamed `server_tool_use` + `web_search_tool_result`. 9router must add
 *     nothing and rewrite nothing.
 *  2. **bridge lane** — the model called the `web_search` function tool. 9router
 *     runs the search at end-of-stream and appends the Anthropic block pair,
 *     pairing them to the model's own tool_use id so the client's transcript
 *     stays consistent.
 *
 * Injection happens in the final `message_delta`, mirroring the safeguards
 * verdict, because that frame is the one Anthropic's own web-search output rides
 * on and the client parses results there.
 */

import {
	isClaudeCodeSearchTool,
	RESULT_ERROR_QUERY_TOO_LONG,
	RESULT_ERROR_UNAVAILABLE,
	SERVER_TOOL_USE_BLOCK,
	SERVER_TOOL_USE_ID_RE,
	WEB_SEARCH_RESULT_BLOCK,
	WEB_SEARCH_TOOL_NAME,
} from "../config/webSearchConstants.ts"
import { SSE_DONE } from "../utils/sseConstants.ts"
import {
	buildSearchBlocks,
	buildSearchErrorBlocks,
	searchFailureNotice,
} from "./webSearchBridge.ts"
import { buildStreamWebSearchInjection } from "./webSearchStreamBuild.ts"
import {
	isSearchToolUseBlock,
	parseSseFrame,
	renderFrame,
	rewriteStopReason,
	suppressSearchToolUseFrames,
} from "./webSearchStreamRender.ts"
import {
	createWebSearchStreamState,
	normalizeToolUseId,
	observeWebSearchFrame,
	pendingSearchCalls,
} from "./webSearchStreamState.ts"

export { buildStreamWebSearchInjection } from "./webSearchStreamBuild.ts"
export {
	createWebSearchStreamState,
	normalizeToolUseId,
	observeWebSearchFrame,
	pendingSearchCalls,
} from "./webSearchStreamState.ts"

export function injectWebSearchIntoStream({ stream, webSearchPlan, log, runSearch, terminate }) {
	if (!webSearchPlan?.active || webSearchPlan.lane === "passthrough") return stream

	const state = createWebSearchStreamState()
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	let doneReading = false
	// Frames are the unit of both observation and suppression, so complete frames
	// are buffered until their terminating blank line arrives. An incomplete
	// trailing frame is never forwarded (it would be dropped mid-parse) and never
	// judged (its content_block_start may still be half-written).
	let pending = ""

	/**
	 * Consume `text`, returning what may safely be forwarded now.
	 * @param {boolean} final flush the trailing partial frame on end-of-stream
	 */
	const consume = (text, final = false) => {
		pending += text
		const parts = pending.split("\n\n")
		// Hold back a trailing fragment that has no terminating blank line yet;
		// on end-of-stream it is complete whether or not it ends in one.
		const tail = final ? "" : parts.pop() || ""
		pending = final ? "" : tail

		const whole = []
		for (const frame of parts) {
			if (!frame) continue
			const complete = `${frame}\n\n`
			observeWebSearchFrame(state, complete)
			whole.push(suppressSearchToolUseFrames(complete, state))
		}
		if (final && pending) {
			observeWebSearchFrame(state, pending)
			whole.push(suppressSearchToolUseFrames(pending, state))
			pending = ""
		}
		return whole.join("")
	}

	return new ReadableStream({
		async pull(controller) {
			if (doneReading) return
			let result
			try {
				result = await reader.read()
			} catch (error) {
				doneReading = true
				try {
					reader.releaseLock()
				} catch {
					/* already released */
				}
				controller.error(error)
				return
			}

			if (result.done) {
				doneReading = true
				let tail = ""
				try {
					tail = consume(decoder.decode(), true)
				} catch {
					/* ignore */
				}
				try {
					reader.releaseLock()
				} catch {
					/* already released */
				}

				if (tail) {
					try {
						controller.enqueue(new TextEncoder().encode(tail))
					} catch {
						/* client gone */
					}
				}

				const injection = await buildStreamWebSearchInjection({ webSearchPlan, state, log, runSearch })
				if (injection) {
					try {
						controller.enqueue(new TextEncoder().encode(injection))
					} catch {
						/* client gone */
					}
				}
				// Replay the terminal frames now that the results are inside the turn.
				if (state.heldMessageDelta) {
					const terminal = rewriteStopReason(state)
					try {
						controller.enqueue(new TextEncoder().encode(terminal))
					} catch {
						/* gone */
					}
				}
				if (state.sawMessageStop) {
					const end = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
					try {
						controller.enqueue(new TextEncoder().encode(end))
					} catch {
						/* client gone */
					}
				}
				try {
					terminate?.()
				} catch {
					/* ignore */
				}
				try {
					controller.close()
				} catch {
					/* ignore */
				}
				return
			}

			// Forward the chunk with the model's own search tool_use held back: the
			// bridge answers that call with Anthropic's native server-tool pair, and
			// Claude Code would otherwise execute the leftover call locally and report
			// "Did 0 searches" while ignoring the results already sent for it.
			let text = ""
			try {
				text = consume(decoder.decode(result.value, { stream: true }))
			} catch {
				/* ignore */
			}

			// A chunk that held nothing but a suppressed block must still enqueue:
			// returning without enqueueing would leave the ReadableStream with nothing
			// to do and it would never call pull() again, stalling the response until
			// the client gave up. An empty enqueue is the correct "kept nothing, keep
			// reading" signal.
			try {
				controller.enqueue(new TextEncoder().encode(text))
			} catch {
				/* client gone */
			}
		},
		cancel(reason) {
			doneReading = true
			try {
				reader.cancel(reason)
			} catch {
				/* ignore */
			}
		},
	})
}
