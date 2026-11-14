/**
 * DeepAI Code (https://deepai.org/chat/ai-code) wire contract.
 *
 * Upstream is api.deepai.org/deepai_code, OpenAI-shaped but not OpenAI-compatible:
 * the key rides `Api-Key` (never `Authorization`), every call names a billing lane,
 * and a device fingerprint decides which daily quota the call is charged to. Two
 * request shapes are also validated: chat needs a leading system/developer message,
 * /responses needs non-empty `instructions`. Both are answered with
 * 400 "This request is not one DeepAI Code sends." when missing.
 *
 * ── The context window is a mirage (measured 2026-11-14) ────────────────
 * GET /deepai_code/models advertises contextWindow 320000 for every model, and
 * the official desktop app (v0.3.37, resources/app.asar → apps/server) lets a
 * thread grow past it. The chat lane does NOT honour that number. Measured with
 * a MARKER0 sentinel in the first turn, then N large turns, asking the model
 * which marker it can still see:
 *
 *   prompt tokens │ what happens
 *   ──────────────┼──────────────────────────────────────────────────────
 *   ≤ ~50k        │ full fidelity — MARKER0 and the secret are still there
 *   ~50k–92k      │ accepted, but the answer comes back EMPTY (completion 200
 *                 │ tokens of nothing). No error field.
 *   > ~92k        │ silently trimmed to ~50.8k and answered from the tail —
 *                 │ MARKER0 gone, first visible marker was MARKER21 at n=40 and
 *                 │ MARKER41 at n=60
 *
 * So there is no single hard wall, but the honest usable budget is ~50k: below
 * it everything works, above it you get either an empty answer or a silently
 * beheaded conversation. That is why capabilities.ts publishes contextWindow
 * 50000 for this provider instead of the catalogue's 320000 — a client that
 * trusts 320k never compacts, which is what put 9router into the >92k zone in
 * the first place.
 *
 * The executor does NOT trim to fit: quietly cutting the conversation here would
 * reproduce the upstream failure with a friendlier face - the model stops
 * knowing things and nobody is told. It throws instead, so a client that can
 * compact compacts, and a combo moves to a member with a bigger window.
 */
import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import nodeMachineId from "node-machine-id"

/**
 * Billing-lane version. Upstream whitelists a range: lanes 1-6 are all accepted
 * today and /theos reports `lane_version: 6`, while 7+ answer 426
 * lane_version_unsupported. Keep this at the highest accepted value and raise it
 * when upstream reports a higher `lane_version`.
 */
export const DEEPAI_CODE_LANE = "6"

/**
 * Upstream's WAF answers 426 lane_version_unsupported to any request whose
 * User-Agent is literally `node`, so an explicit UA is mandatory rather than
 * cosmetic. Any other value passes; it is not a fingerprint.
 */
export const DEEPAI_CODE_UA = "9router/1.0"

/** Minimal filler for the leading turn upstream insists on. Content is not checked. */
export const DEEPAI_CODE_SYSTEM_FILLER = "You are DeepAI Code."

/**
 * Prompt tokens this lane is safe to use. Measured, not advertised: below ~50k
 * a conversation keeps full fidelity, above it the lane either answers with
 * nothing or silently drops the oldest turns. The catalogue's 320000 is a
 * number the lane does not enforce, so capabilities.ts publishes this value
 * too - a client that trusts 320k never compacts, which is how a thread ends up
 * in the empty-answer or beheaded zone. See the file header for the zones.
 */
export const DEEPAI_CODE_CONTEXT_BUDGET = 50000

/**
 * Point past which answers degrade: empty completions start here, and beyond
 * ~92k the lane trims to ~50.8k and answers from the tail. Kept as a ceiling so
 * a request this module lets through is one the lane still answers properly.
 */
export const DEEPAI_CODE_CONTEXT_CEILING = 60000

/** Output ceiling the lane honours; the catalogue's per-model maxTokens is higher. */
export const DEEPAI_CODE_MAX_OUTPUT = 64000

let machineHash: string | null = null
let instanceId: string | null = null
let sessionId: string | null = null

function sha256Hex(value: string) {
	return createHash("sha256").update(value).digest("hex")
}

function rawMachineId(): string {
	try {
		return nodeMachineId.machineIdSync()
	} catch {
		return `${os.hostname()}|${os.platform()}|${os.arch()}`
	}
}

/** sha256 of the lowercased raw device id - upstream's daily-quota allocation key. */
export function deepaiCodeMachineId(): string {
	if (!machineHash) machineHash = sha256Hex(rawMachineId().trim().toLowerCase())
	return machineHash
}

/** 32 hex, one per process: the client-instance id the desktop app also sends. */
export function deepaiCodeInstanceId(): string {
	if (!instanceId) instanceId = randomBytes(16).toString("hex")
	return instanceId
}

/** Conversation stickiness: keeps a session on one upstream worker. */
export function deepaiCodeSessionId(): string {
	if (!sessionId) sessionId = `ses_${randomBytes(12).toString("hex")}`
	return sessionId
}

/** The header set every DeepAI Code call needs on top of the transport's own. */
export function buildDeepAiCodeHeaders(
	apiKey: string | null | undefined,
	lane: string = DEEPAI_CODE_LANE,
): Record<string, string> {
	return {
		"Api-Key": apiKey ?? "",
		"X-DeepAI-Code-Theos": lane,
		"X-DeepAI-Code-Machine": deepaiCodeMachineId(),
		"X-DeepAI-Code-Instance": deepaiCodeInstanceId(),
		"X-Session-Affinity": deepaiCodeSessionId(),
	}
}

/**
 * Give the body the shape upstream validates, leaving every other field alone.
 *
 * Chat: a leading `system`/`developer` turn. Responses: non-empty `instructions`
 * (the translator only fills it from a system message, so a client that sent none
 * would otherwise reach upstream empty).
 */
export function ensureDeepAiCodeShape(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return body
	const shaped = body as Record<string, unknown>

	if (!Array.isArray(shaped.messages)) {
		if (shaped.input === undefined) return body
		const instructions = shaped.instructions
		if (typeof instructions === "string" && instructions.trim()) return body
		return { ...shaped, instructions: DEEPAI_CODE_SYSTEM_FILLER }
	}

	const first = shaped.messages[0] as { role?: unknown } | undefined
	const role = typeof first?.role === "string" ? first.role : ""
	if (role === "system" || role === "developer") return body
	return {
		...shaped,
		messages: [{ role: "system", content: DEEPAI_CODE_SYSTEM_FILLER }, ...shaped.messages],
	}
}

/**
 * Thrown when a request exceeds the window this lane can actually answer.
 *
 * Deliberately an error, not a trim. Upstream silently discards the oldest
 * turns once a prompt is too large, which is what made the original bug
 * unreadable: the model simply stopped knowing things, with no signal anywhere.
 * Quietly trimming on the router's side would reproduce that exact failure with
 * a nicer face. The caller gets a real 400 instead, so a client that can compact
 * compacts, and a person sees why.
 */
export class DeepAiCodeContextError extends Error {
	readonly code = "context_length_exceeded"
	readonly statusCode = 400
	constructor(message: string) {
		super(message)
		this.name = "DeepAiCodeContextError"
	}
}

/**
 * Rough token count for one message's content. Deliberately an estimate: the
 * point is to stay under a budget that carries slack, not to match the vendor
 * tokenizer. Text is ~4 chars/token; images and tool payloads carry their own
 * weight.
 */
function estimateContentTokens(content: unknown): number {
	if (content == null) return 0
	if (typeof content === "string") return Math.ceil(content.length / 4)
	if (Array.isArray(content)) {
		let total = 0
		for (const part of content) {
			if (!part || typeof part !== "object") {
				total += 1
				continue
			}
			const p = part as Record<string, unknown>
			// A vision part gets a flat, generous allowance: the endpoint bills
			// images per tile and no local estimate beats a fixed guess.
			if (p.type === "image" || p.type === "image_url" || p.type === "input_image") {
				total += 1200
				continue
			}
			if (typeof p.text === "string") {
				total += Math.ceil(p.text.length / 4)
				continue
			}
			if (typeof p.content === "string") {
				total += Math.ceil(p.content.length / 4)
				continue
			}
			// Anything else (a tool schema, a tool_use block, a nested object)
			// costs what its serialized form costs - descriptions and JSON
			// schemas are not free just because they carry no `text` field.
			try {
				total += Math.ceil(JSON.stringify(p).length / 4)
			} catch {
				total += 16
			}
		}
		return total
	}
	if (typeof content === "object") {
		try {
			return Math.ceil(JSON.stringify(content).length / 4)
		} catch {
			return 0
		}
	}
	return 0
}

/** Estimated prompt tokens for a whole message list, including tool schemas. */
export function estimateDeepAiCodeTokens(body: unknown): number {
	if (!body || typeof body !== "object" || Array.isArray(body)) return 0
	const shaped = body as Record<string, unknown>
	let total = 0
	const list = Array.isArray(shaped.messages)
		? shaped.messages
		: Array.isArray(shaped.input)
			? shaped.input
			: []
	for (const msg of list) {
		if (!msg || typeof msg !== "object") continue
		const m = msg as Record<string, unknown>
		total += 4 // per-message envelope
		total += estimateContentTokens(m.content)
		// Tool calls and tool results live outside `content` on both wire shapes.
		if (Array.isArray(m.tool_calls)) total += estimateContentTokens(m.tool_calls)
		if (m.function_call) total += estimateContentTokens(m.function_call)
		if (Array.isArray(m.tool_use)) total += estimateContentTokens(m.tool_use)
		if (Array.isArray(m.tool_result)) total += estimateContentTokens(m.tool_result)
		if (typeof m.reasoning_content === "string") total += Math.ceil(m.reasoning_content.length / 4)
		if (Array.isArray(m.reasoning_details)) total += estimateContentTokens(m.reasoning_details)
	}
	if (Array.isArray(shaped.tools)) total += estimateContentTokens(shaped.tools)
	if (typeof shaped.instructions === "string") total += Math.ceil(shaped.instructions.length / 4)
	return total
}

/**
 * Reject a request this lane cannot answer, instead of trimming it.
 *
 * Two things must never happen here, and both happened in the original bug:
 *   1. Sending an oversized prompt and letting upstream drop its head silently.
 *   2. Trimming it ourselves so the caller never learns the context was lost.
 * So this throws. The message names the numbers and says what to do, because the
 * caller is usually an agent that can compact when told.
 *
 * Fail-open on shapes we cannot measure: a body this does not recognise is
 * passed through rather than rejected on a bad guess.
 */
export function assertDeepAiCodeContextFits(
	body: unknown,
	budget: number = DEEPAI_CODE_CONTEXT_BUDGET,
): number {
	const estimated = estimateDeepAiCodeTokens(body)
	if (estimated <= budget) return estimated
	throw new DeepAiCodeContextError(
		`Prompt is ~${estimated} tokens, but DeepAI Code only answers up to ${budget} ` +
			`(the provider advertises more and then silently drops the oldest turns). ` +
			`Compact the conversation or start a new one.`,
	)
}

export const __test__ = {
	sha256Hex,
	rawMachineId,
	estimateContentTokens,
}
