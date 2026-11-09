import { AWS_EVENTSTREAM } from "../config/awsConstants.ts"

export const KIRO_REPAIR_BUFFER_MAX_BYTES = 8 * 1024 * 1024
// Regions per service host; a region outside the set is never spliced into the hostname.
export const KIRO_SERVICE_REGIONS = {
	q: new Set(["us-east-1", "eu-central-1"]),
	runtime: new Set(["us-east-1", "eu-central-1"]),
	codewhisperer: new Set(["us-east-1"]),
}
export const KIRO_REPAIR_HEARTBEAT_MS = 10_000
export const KIRO_SHORT_FINAL_MAX_CHARS = 800
export const EVENTSTREAM_MAX_MESSAGE_BYTES = AWS_EVENTSTREAM.maxMessageBytes
export const EVENTSTREAM_MAX_HEADERS_BYTES = AWS_EVENTSTREAM.maxHeadersBytes
export const KIRO_EVENT_TYPES = new Set([
	"assistantResponseEvent",
	"reasoningContentEvent",
	"codeEvent",
	"toolUseEvent",
	"messageStopEvent",
	"metadataEvent",
	"MetadataEvent",
	"contextUsageEvent",
	"meteringEvent",
	"metricsEvent",
])
export const encoder = new TextEncoder()
export const decoder = new TextDecoder()
export const REPAIR_INSTRUCTIONS = Object.freeze({
	tool:
		"Retry the previous response because its Kiro tool_call wrapper was malformed. If you use the wrapper tool named tool_call, its input must contain a non-empty name and an arguments field.",
	ellipsis:
		"Retry the previous response because it ended with only an ellipsis. Return the complete final answer, not only ... or ….",
	short_final:
		"Retry the previous response because its final only announced a future action. Complete the check now and return the result or a concrete blocker.",
})
export const SHORT_FUTURE_ACTION =
	/^(?:(?:(?:現在|接著|接下來|下一步)[，,:：\s]*(?:我(?:只)?(?:會|要|將|再)?\s*)?|我只再)(?:補|查|確認|驗證|追(?:查|蹤)?|繼續|檢查|測試)|我(?:會|要|將)(?:再|重新)?(?:補(?:齊|查)?|抓取|查(?:詢)?|確認|驗證|追(?:查|蹤)?|繼續|檢查|測試)|(?:(?:next|now|then)\b[\s,:-]*)?(?:i(?:'ll| will| am going to| need to)|let me)\s+(?:verify|check|confirm|validate|investigate|trace|continue|follow up|test)\b)/iu
// Keep this tied to the observed whole-response signature. Broader Chinese
// result/progress heuristics create false positives for completed findings.
export const OBSERVED_TRAILING_FUTURE_ACTION =
	/^目前證據顯示[\s\S]{1,700}[。.!?；;]\s*最後補查\s+504\s+access\s+log[，,]\s*確認\s+host[／/]路徑與是否為集中流量[。.!]?$/iu
export const ENGLISH_FUTURE_ACTION =
	/^(?:(?:next|now|then)\b[\s,:-]*)?(?:i(?:'ll| will| am going to| need to)|let me)\s+(?:verify|check|confirm|validate|investigate|trace|continue|follow up|test)\b/iu
export const ENGLISH_RESULT_CLAUSE =
	/(?:[:;\n]|[.!?]\s+\S|\b(?:status|checksum|response|deployment)\s+(?:is|are|was|were|matches?|equals?|returned)\b)/iu
export const CHINESE_FUTURE_ACTION =
	/^(?:(?:現在|接著|接下來|下一步)[，,:：\s]*(?:我(?:只)?(?:會|要|將|再)?\s*)?|我只再|我(?:會|要|將)(?:再|重新)?)(?:補|抓取|查|確認|驗證|追|繼續|檢查|測試)/u
export const CHINESE_RESULT_CLAUSE =
	/(?:[。！？]\s*\S|(?:版本|狀態|回應|結果|部署|校驗碼)(?:是|為|等於|顯示))/u
export const USER_WAIT =
	/(?:請(?:你|先)|你(?:先|需要|可以|提供|確認|批准|允許)|等待(?:你|使用者)|等你|核准|同意|授權|\b(?:after|when|once)\s+you\b|\byour\s+(?:approval|confirmation|permission|input)\b|\bwait(?:ing)?\s+for\s+you\b|\bplease\s+(?:approve|confirm|provide|send)\b)/iu
export const COMPLETED_FINAL =
	/(?:已(?:經)?完成|完成(?:了|驗證|確認)|修復完成|確認無誤|驗證(?:完成|通過)|測試(?:均)?通過|結論|總結|\b(?:done|completed|fixed|verified|confirmed|passed|in conclusion|summary)\b|\b(?:is|are) complete\b)/iu
export const RESULT_EVIDENCE =
	/(?:顯示|發現|因此|成功|失敗|正常|無錯誤|沒有錯誤|\b(?:found|shows?|showed|because|therefore|succeeded|failed|healthy|green|no errors?)\b)/iu

export function envPositiveInt(name, fallback) {
	const parsed = Number.parseInt(process.env?.[name] || "", 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Read Kiro's native token accounting out of a terminal `metadataEvent`.
 *
 * The upstream reports real counts under `tokenUsage`:
 *   { totalTokens, outputTokens, uncachedInputTokens,
 *     cacheReadInputTokens, cacheWriteInputTokens }
 * `prompt_tokens` is the sum of the three input buckets; `totalTokens` is only a
 * fallback for routes that omit the buckets. Returns null when the event carried
 * no usable count, so the caller can tell "no usage reported" from "zero usage".
 */
export function readKiroTokenUsage(
	tokenUsage: Record<string, unknown>,
): Record<string, number> | null {
	if (!tokenUsage || typeof tokenUsage !== "object") return null
	const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0)
	const output = num(tokenUsage.outputTokens)
	const uncached = num(tokenUsage.uncachedInputTokens)
	const cacheRead = num(tokenUsage.cacheReadInputTokens)
	const cacheWrite = num(tokenUsage.cacheWriteInputTokens)
	const total = num(tokenUsage.totalTokens)
	const input = uncached + cacheRead + cacheWrite
	if (!input && !output && !total) return null
	const prompt = input || Math.max(0, total - output)
	const usage: Record<string, number> = {
		prompt_tokens: prompt,
		completion_tokens: output,
		// Prefer totalTokens verbatim when present; otherwise sum the buckets.
		total_tokens: total || prompt + output,
	}
	if (cacheRead) usage.cache_read_input_tokens = cacheRead
	if (cacheWrite) usage.cache_creation_input_tokens = cacheWrite
	return usage
}

/** Options threaded into {@link KiroExecutor.transformEventStreamToSSE}. */
export interface KiroStreamTransformOptions {
	/** Hard cap on buffered tool-input bytes before the stream fails. */
	maxToolBytes?: number
	/** Hard cap on buffered raw EventStream bytes before the stream fails. */
	maxRawBytes?: number
	/** Original request body, used to estimate prompt tokens when upstream omits usage. */
	requestBody?: Record<string, unknown>
	/** Declared tool specs from the request, for tool-call name validation. */
	toolSpecs?: unknown[]
	/** Notified once with the terminal diagnostics for the turn. */
	onTerminalState?: (diagnostics: Record<string, unknown>) => void
}

export function concatChunks(chunks, totalBytes) {
	const output = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

export function makeAbortError(reason) {
	const error = new Error(reason?.message || reason || "Request aborted")
	error.name = "AbortError"
	return error
}

export async function readWithTimeout(reader, signal, timeoutMs, message) {
	if (signal?.aborted) throw makeAbortError(signal.reason)
	let timeout
	let abortHandler
	const timeoutPromise = new Promise((_, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
	})
	const abortPromise = new Promise((_, reject) => {
		abortHandler = () => reject(makeAbortError(signal.reason))
		signal?.addEventListener("abort", abortHandler, { once: true })
	})
	try {
		return await Promise.race([reader.read(), timeoutPromise, abortPromise])
	} finally {
		clearTimeout(timeout)
		signal?.removeEventListener?.("abort", abortHandler)
	}
}

export async function readResponsePrefix(response, signal, maxBytes, timeoutMs) {
	const reader = response?.body?.getReader?.()
	if (!reader) return ""
	const chunks = []
	let totalBytes = 0
	try {
		while (totalBytes < maxBytes) {
			const { done, value } = await readWithTimeout(
				reader,
				signal,
				timeoutMs,
				"Kiro retry error body stalled",
			)
			if (done) break
			const remaining = maxBytes - totalBytes
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
			chunks.push(chunk)
			totalBytes += chunk.byteLength
			if (value.byteLength > remaining) break
		}
	} finally {
		await reader.cancel("bounded Kiro retry error body").catch(() => {})
	}
	return decoder.decode(concatChunks(chunks, totalBytes))
}

// The instruction goes into the current user turn, never into a top-level
// `systemPrompt`: kiro.dev answers any body carrying that field with
// 400 REQUEST_BODY_INVALID, so writing it here turned every repair retry into
// a hard failure.
export function appendRepairInstruction(body, kind) {
	const repaired = structuredClone(body || {})
	const instruction = REPAIR_INSTRUCTIONS[kind] || "Retry the previous incomplete Kiro response."
	const msg = repaired?.conversationState?.currentMessage?.userInputMessage
	if (msg) {
		const content = typeof msg.content === "string" ? msg.content : ""
		msg.content = content ? `${content}\n\n${instruction}` : instruction
	}
	return repaired
}

export function normalizeStopReason(value) {
	const reason = String(value || "")
		.trim()
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[\s-]+/g, "_")
	if (["endturn", "end_turn", "stop", "stop_sequence"].includes(reason)) return "end_turn"
	if (["tooluse", "tool_use", "tool_calls"].includes(reason)) return "tool_use"
	if (["maxtokens", "max_tokens", "max_output_tokens", "length"].includes(reason))
		return "max_tokens"
	return reason || null
}

// Of the reasons stopDisposition() folds into "terminal_incomplete", only these
// mean "usable as far as it got, then the budget ran out" -- the case
// finish_reason "length" exists for. cancelled / pause_turn are abandoned turns
// whose partial content must stay private, so they are deliberately absent.
export const KIRO_TRUNCATION_STOP_REASONS = new Set(["model_context_window_exceeded", "max_tokens"])

export function stopDisposition(stopReason, hasToolCalls) {
	if (["malformed_model_output", "invalid_model_output"].includes(stopReason))
		return "retryable_protocol_failure"
	if (["cancelled", "pause_turn", "model_context_window_exceeded"].includes(stopReason))
		return "terminal_incomplete"
	if (
		stopReason === "refusal" ||
		/(?:content.*filter|guardrail|safety|policy|blocked)/u.test(stopReason)
	)
		return "terminal_refusal"
	if (stopReason === "max_tokens") return hasToolCalls ? "terminal_incomplete" : "length"
	if (stopReason && !["end_turn", "tool_use"].includes(stopReason)) return "unknown_failure"
	if (hasToolCalls || stopReason === "tool_use") return "tool_use"
	if (!stopReason || stopReason === "end_turn") return "complete"
	return "unknown_failure"
}

export function mergeStopReason(current, incoming) {
	if (!incoming) return current
	if (!current) return incoming
	const severity = (reason) => {
		const disposition = stopDisposition(reason, false)
		if (disposition === "terminal_refusal") return 6
		if (disposition === "terminal_incomplete") return 5
		if (disposition === "unknown_failure") return 4
		if (disposition === "retryable_protocol_failure") return 3
		if (disposition === "length") return 2
		return 1
	}
	return severity(incoming) > severity(current) ? incoming : current
}

export function isEllipsisOnly(value) {
	return ["...", "…"].includes(String(value || "").trim())
}

export function isShortFutureAction(value) {
	const text = String(value || "")
		.trim()
		.replaceAll("’", "'")
	if (OBSERVED_TRAILING_FUTURE_ACTION.test(text)) return true
	if (ENGLISH_FUTURE_ACTION.test(text) && ENGLISH_RESULT_CLAUSE.test(text)) return false
	if (CHINESE_FUTURE_ACTION.test(text) && CHINESE_RESULT_CLAUSE.test(text)) return false
	return (
		text.length > 0 &&
		text.length <= KIRO_SHORT_FINAL_MAX_CHARS &&
		SHORT_FUTURE_ACTION.test(text) &&
		!USER_WAIT.test(text) &&
		!COMPLETED_FINAL.test(text) &&
		!RESULT_EVIDENCE.test(text)
	)
}

export function encodeSSEError(code: string, message: string, details?: Record<string, unknown>) {
	return encoder.encode(
		`data: ${JSON.stringify({
			error: {
				message,
				type: "upstream_error",
				code,
				...(details ? { details } : {}),
			},
		})}\n\ndata: [DONE]\n\n`,
	)
}

export function inspectSSEChunk(chunk, state) {
	for (const line of decoder.decode(chunk).split("\n")) {
		if (!line.startsWith("data: ")) continue
		const data = line.slice(6).trim()
		if (!data || data === "[DONE]") continue
		try {
			const event = JSON.parse(data)
			if (event.error) state.error = event.error
			for (const choice of event.choices || []) {
				const delta = choice.delta || {}
				if (typeof delta.content === "string") state.content += delta.content
				if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content
				if (delta.tool_calls?.length) state.hasToolCalls = true
			}
		} catch {
			/* a malformed SSE line is diagnosed by the transformer */
		}
	}
}

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
