/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - image_url / image source → {type:"image", image:"data:...;base64,...", mimeType}
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */

import { COMMAND_CODE_WORKING_DIR } from "../../shared/commandCodeHeaders.ts"
import { commandCodeThreadId } from "../../utils/commandCodeSession.ts"
import { encodeDataUri, parseDataUri } from "../concerns/image.ts"
import { FORMATS } from "../formats.ts"
import { register } from "../index.ts"
import { CLAUDE_BLOCK, OPENAI_BLOCK, ROLE } from "../schema/index.ts"

function flattenText(content) {
	if (content == null) return ""
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		const parts = []
		for (const p of content) {
			if (typeof p === "string") parts.push(p)
			else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text)
		}
		return parts.join("\n")
	}
	return String(content)
}

function toNativeImageBlock(part) {
	if (!part || typeof part !== "object") return null

	if (part.type === OPENAI_BLOCK.IMAGE_URL) {
		const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
		const parsed = parseDataUri(url)
		if (!parsed) return null
		return {
			type: OPENAI_BLOCK.IMAGE,
			image: encodeDataUri(parsed.mimeType, parsed.base64),
			mimeType: parsed.mimeType,
		}
	}

	if (part.type === OPENAI_BLOCK.IMAGE || part.type === CLAUDE_BLOCK.IMAGE) {
		if (typeof part.image === "string" && part.image.startsWith("data:")) {
			const parsed = parseDataUri(part.image)
			const mime = part.mimeType || parsed?.mimeType || "image/png"
			return {
				type: OPENAI_BLOCK.IMAGE,
				image: part.image,
				mimeType: mime,
			}
		}
		const source = part.source
		if (source?.type === "base64" && typeof source.data === "string") {
			const mime = source.media_type || "image/png"
			return {
				type: OPENAI_BLOCK.IMAGE,
				image: encodeDataUri(mime, source.data),
				mimeType: mime,
			}
		}
	}

	return null
}

function toContentBlocks(content) {
	if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }]
	if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }]
	if (Array.isArray(content)) {
		const blocks = []
		for (const part of content) {
			if (typeof part === "string") {
				blocks.push({ type: OPENAI_BLOCK.TEXT, text: part })
			} else if (part && typeof part === "object") {
				if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
					blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text })
				} else {
					const image = toNativeImageBlock(part)
					if (image) blocks.push(image)
					else if (typeof part.text === "string") {
						blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text })
					}
				}
			}
		}
		return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }]
	}
	return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }]
}

/**
 * Parse a tool-call argument string into the object `/alpha/generate` expects.
 *
 * A client that streams half a JSON document, or a provider that re-sends an
 * already-parsed value, used to end up as `{}` and the model then ran the tool
 * with no arguments at all. Keeping the unparsable text under `raw` at least
 * lets the model see what was asked for.
 */
function safeParseJson(s) {
	if (s == null) return {}
	if (typeof s !== "string") return s
	const trimmed = s.trim()
	if (!trimmed) return {}
	try {
		const parsed = JSON.parse(trimmed)
		if (parsed && typeof parsed === "object") return parsed
		return { value: parsed }
	} catch {
		return { raw: s }
	}
}

/**
 * Command Code's own default when the client sends no budget.
 *
 * Kept separate from `DEFAULT_MAX_TOKENS` in config/runtimeConfig.ts: this is a
 * wire contract of the CLI version below, not a policy other providers inherit.
 */
const COMMAND_CODE_MAX_TOKENS = 64000

function convertMessages(messages = []) {
	const out = []
	const systemTexts = []
	// toolCallId -> toolName across every assistant turn. A standard OpenAI or
	// Claude tool-response turn omits the name on role:"tool", so without this the
	// toolName would be "" and upstream /alpha/generate rejects the request.
	const toolCallIdToName = new Map()
	for (const m of messages) {
		if (m?.role === ROLE.ASSISTANT && Array.isArray(m.tool_calls)) {
			for (const tc of m.tool_calls) {
				const name = tc?.function?.name || tc?.name
				if (tc?.id && name) toolCallIdToName.set(tc.id, name)
			}
		}
	}

	for (const m of messages) {
		if (!m) continue
		const role = m.role

		if (role === ROLE.SYSTEM) {
			const t = flattenText(m.content)
			if (t) systemTexts.push(t)
			continue
		}

		if (role === ROLE.TOOL) {
			const value = typeof m.content === "string" ? m.content : flattenText(m.content)
			// A failed execution is its own block type on this wire, not a text
			// result: the CLI renders error-text differently and the model is told
			// the call did not succeed.
			const isError = Boolean(m.is_error || m.status === "error")
			const toolName =
				m.name || (m.tool_call_id ? toolCallIdToName.get(m.tool_call_id) : null) || "unknown"
			out.push({
				role: ROLE.TOOL,
				content: [
					{
						type: "tool-result",
						toolCallId: m.tool_call_id || "",
						toolName,
						output: { type: isError ? "error-text" : "text", value },
					},
				],
			})
			continue
		}

		if (role === ROLE.ASSISTANT) {
			const blocks = []
			// CommandCode requires reasoning_content on every earlier assistant
			// message in multi-turn history ("send back the 'reasoning_content'
			// returned with that message"). Clients in Claude format carry reasoning
			// inside content `thinking` blocks rather than a top-level field, so
			// extract the real reasoning text here instead of falling back to a
			// placeholder (which upstream rejects).
			let rc = m.reasoning_content ?? m.thought ?? m.reasoning
			if ((rc == null || rc === "") && Array.isArray(m.content)) {
				const thinkingBlock = m.content.find(
					(b) => b && b.type === "thinking" && typeof b.thinking === "string",
				)
				if (thinkingBlock) rc = thinkingBlock.thinking
			}
			const rcStr = typeof rc === "string" ? rc : rc == null ? "" : String(rc)
			// Only a real reasoning text earns a block. A tool-call turn with no
			// reasoning used to get a placeholder " " block, which the CLI echoes
			// back as bogus reasoning on the next turn.
			if (rcStr.trim()) {
				blocks.push({ type: "reasoning", text: rcStr })
			}
			const text = flattenText(m.content)
			if (text) blocks.push({ type: OPENAI_BLOCK.TEXT, text })
			if (Array.isArray(m.tool_calls)) {
				for (const tc of m.tool_calls) {
					const fn = tc.function || {}
					blocks.push({
						type: "tool-call",
						toolCallId: tc.id || "",
						toolName: fn.name || tc.name || "",
						// `tc.input` is the already-parsed shape a Claude-format client
						// re-sends on the way back; arguments wins when both exist.
						input: safeParseJson(fn.arguments ?? tc.input),
					})
				}
			}
			out.push({
				role: ROLE.ASSISTANT,
				content: blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }],
				reasoning_content: rcStr.trim() ? rcStr : " ",
			})
			continue
		}

		out.push({ role: ROLE.USER, content: toContentBlocks(m.content) })
	}

	return { messages: out, system: systemTexts.join("\n\n") }
}

function convertTools(tools) {
	if (!Array.isArray(tools) || tools.length === 0) return undefined
	const result = []
	for (const t of tools) {
		if (!t) continue
		if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
			result.push({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters || { type: "object" },
			})
		} else if (t.name && (t.input_schema || t.parameters)) {
			result.push({
				name: t.name,
				description: t.description,
				input_schema: t.input_schema || t.parameters,
			})
		}
	}
	return result.length ? result : undefined
}

export function openaiToCommandCodeRequest(model, body, stream /* , credentials */) {
	const { messages, system } = convertMessages(body.messages)
	const params: {
		model: unknown
		messages: unknown
		stream: boolean
		max_tokens: unknown
		temperature: unknown
		system?: unknown
		tools?: unknown
		top_p?: unknown
		reasoning_effort?: string
	} = {
		model,
		messages,
		stream: stream !== false,
		max_tokens: body.max_tokens ?? body.max_output_tokens ?? COMMAND_CODE_MAX_TOKENS,
		temperature: body.temperature ?? 0.3,
	}

	if (system) params.system = system

	const tools = convertTools(body.tools)
	if (tools) params.tools = tools
	if (body.top_p != null) params.top_p = body.top_p

	// Effort as the client asked for it: OpenAI reasoning_effort, Claude
	// output_config.effort, or the nested Responses shape. The valid level set and
	// clamping are the thinking concern's job (applyThinking, targetFormat
	// "commandcode"); this only forwards the intent it captured.
	const effort =
		body.reasoning_effort ??
		body.output_config?.effort ??
		(typeof body.reasoning === "object" ? body.reasoning?.effort : null)
	if (effort && typeof effort === "string") params.reasoning_effort = effort

	const today = new Date().toISOString().slice(0, 10)

	return {
		// Conversation-stable: the upstream prompt cache is keyed on this id, so it
		// must stay constant across the turns of one conversation (see
		// utils/commandCodeSession.js). A random id here re-caches the whole prefix
		// on every request.
		threadId: commandCodeThreadId(body),
		// The CLI reads these as nullable slots; an empty string made it look for a
		// memory/taste bundle at "" and fail the data path.
		memory: null,
		taste: null,
		skills: null,
		permissionMode: "standard",
		config: {
			workingDir: COMMAND_CODE_WORKING_DIR,
			date: today,
			environment: process.platform,
			structure: [],
			isGitRepo: false,
			currentBranch: "",
			mainBranch: "",
			gitStatus: "",
			recentCommits: [],
		},
		params,
	}
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCodeRequest, null)
