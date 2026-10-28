/**
 * Per-session reasoning store for CommandCode `/alpha/generate`.
 *
 * CommandCode thinking models require `reasoning_content` to be echoed back on
 * every earlier assistant message in multi-turn history (400
 * "Missing required parameter: 'messages[N].reasoning_content'").
 *
 * Claude Code clients send plain text in request history (no thinking blocks),
 * and 9router strips `reasoning_content` from CommandCode responses before
 * relaying them to the client, so the client never stores it. We therefore
 * capture CommandCode's reasoning per assistant turn and replay it on the next
 * request, keyed by the CommandCode session id (threadId).
 *
 * Store shape: Map<sessionId, { reasoning: string[], lastUsed }>
 *   reasoning[k] = the reasoning text CommandCode returned for its k-th
 *   assistant turn in this session (ordinal among assistant messages).
 */

import { MEMORY_CONFIG } from "../config/runtimeConfig.ts"

const reasoningStore = new Map()
const MAX_SESSIONS = 5000

function evictIfNeeded() {
	if (reasoningStore.size < MAX_SESSIONS) return
	const oldest = reasoningStore.keys().next().value
	if (oldest !== undefined) reasoningStore.delete(oldest)
}

const cleanup = setInterval(() => {
	const now = Date.now()
	for (const [key, entry] of reasoningStore.entries()) {
		if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) reasoningStore.delete(key)
	}
}, MEMORY_CONFIG.sessionCleanupIntervalMs)
if (cleanup.unref) cleanup.unref()

/** Append the reasoning text for the next assistant turn in this session. */
export function appendCommandCodeReasoning(sessionId, reasoning) {
	if (!sessionId || typeof reasoning !== "string") return
	evictIfNeeded()
	let entry = reasoningStore.get(sessionId)
	if (!entry) {
		entry = { reasoning: [], lastUsed: Date.now() }
		reasoningStore.set(sessionId, entry)
	}
	entry.reasoning.push(reasoning)
	entry.lastUsed = Date.now()
}

/** Retrieve the stored reasoning for a given session + assistant ordinal. Returns null when absent. */
export function getCommandCodeReasoning(sessionId, ordinal) {
	if (!sessionId || ordinal == null) return null
	const entry = reasoningStore.get(sessionId)
	if (!entry || !Array.isArray(entry.reasoning)) return null
	entry.lastUsed = Date.now()
	const value = entry.reasoning[ordinal]
	return value == null ? null : value
}

/** Clear the whole store (mostly for tests). */
export function clearCommandCodeReasoningStore() {
	reasoningStore.clear()
}
