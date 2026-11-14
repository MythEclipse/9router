/**
 * DeepAI Code (https://deepai.org/chat/ai-code) wire contract.
 *
 * Upstream is api.deepai.org/deepai_code, OpenAI-shaped but not OpenAI-compatible:
 * the key rides `Api-Key` (never `Authorization`), every call names a billing lane,
 * and a device fingerprint decides which daily quota the call is charged to. Two
 * request shapes are also validated: chat needs a leading system/developer message,
 * /responses needs non-empty `instructions`. Both are answered with
 * 400 "This request is not one DeepAI Code sends." when missing.
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

export const __test__ = {
	sha256Hex,
	rawMachineId,
}
