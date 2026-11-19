/**
 * Reading a chat request body, whatever format it arrived in.
 *
 * The memory stage sits above the translator, so it sees the client's own wire
 * shape — OpenAI `messages`, Responses `input`, Claude `system` + `messages`,
 * Gemini `contents`. It needs two things from that body and nothing else: the last
 * thing the user said (the recall query) and the conversation in order (the retain
 * delta). Both are best-effort: an unfamiliar shape answers empty rather than
 * throwing, because the stage is fail-open by contract.
 */

/** One message reduced to what memory needs: who said it, and the text. */
export interface PlainMessage {
	role: string
	text: string
}

/**
 * Remove an injected memory block from a message.
 *
 * Recall injects `<memory>…</memory>` into the request body, and retain reads that
 * same body — so without this the recalled facts are written back into the bank on
 * every turn. That is a feedback loop, not a copy: the next recall retrieves the
 * re-retained text, extraction rewords it, and the block grows. One real document
 * measured 5,875 chars of which nearly all was the block, dwarfing the two turns it
 * was supposed to record.
 *
 * Stripping here rather than skipping the message keeps the original turn: only the
 * injected envelope goes, and the user's own words stay.
 */
export function stripMemoryBlock(text: string): string {
	if (!text || !text.includes("<memory>")) return text
	return text
		.replace(/<memory>[\s\S]*?<\/memory>/g, "")
		.replace(/<memory>[\s\S]*$/g, "")
		.trim()
}

/** The text of a content value: a string, or the text blocks of an array. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block)
			continue
		}
		if (!block || typeof block !== "object") continue
		const record = block as Record<string, unknown>
		// OpenAI/Claude text blocks and Responses input_text blocks.
		if (typeof record.text === "string") parts.push(record.text)
		// Gemini parts.
		else if (typeof record.content === "string") parts.push(record.content)
	}
	return parts.join("\n").trim()
}

/**
 * The conversation in order, from whichever field the body uses.
 *
 * Roles are normalized to `user` / `assistant` / `system` / `tool`; an unknown
 * role is kept verbatim so the retained transcript still reads correctly.
 */
export function plainMessages(body: Record<string, unknown> | null | undefined): PlainMessage[] {
	if (!body || typeof body !== "object") return []

	const candidates = [
		body.messages,
		body.input,
		body.contents,
		(body.request as Record<string, unknown> | undefined)?.contents,
	]
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue
		const messages: PlainMessage[] = []
		for (const item of candidate) {
			if (!item || typeof item !== "object") continue
			const record = item as Record<string, unknown>
			const rawRole = typeof record.role === "string" ? record.role : ""
			// Gemini uses `parts` with no role on system turns; Responses items carry
			// `type: "message"` and a role only on the message variants.
			const role = rawRole === "model" ? "assistant" : rawRole
			const text =
				textOf(record.content) ||
				textOf(record.parts) ||
				(typeof record.text === "string" ? record.text : "")
			// Recall may have injected a memory block into an earlier turn of this very
			// body; retaining it would write the bank back into itself.
			const clean = stripMemoryBlock(text)
			if (!clean) continue
			messages.push({ role: role || "unknown", text: clean })
		}
		if (messages.length > 0) return messages
	}
	return []
}

/**
 * The query for a recall: the last user message, truncated.
 *
 * Hindsight rejects queries over ~500 tokens, and a recall query is a search
 * string rather than a prompt — sending the transcript would be both rejected and
 * billed. `maxChars` keeps it comfortably inside that limit.
 */
export function lastUserQuery(
	body: Record<string, unknown> | null | undefined,
	maxChars = 1000,
): string {
	const messages = plainMessages(body)
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message.role === "user" && message.text.trim()) {
			return message.text.trim().slice(0, maxChars)
		}
	}
	return ""
}
