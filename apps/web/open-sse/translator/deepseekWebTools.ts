// DeepSeek-web-specific tool-call translation.
//
// chat.deepseek.com has no native function calling, so we serialize the OpenAI
// `tools[]` into a prompt contract and parse the model's text reply back into OpenAI
// `tool_calls`. The canonical `webTools.js` parser handles the well-behaved
// `<tool>{json}</tool>` / bare-JSON shapes used by most web-cookie providers, and it MUST
// stay untouched (it works for the others).
//
// DeepSeek, however, emits a much wider zoo of ad-hoc shapes:
//   <tool:todowrite>{json}</tool>            name in the tag suffix, body is the arguments
//   <tool_call>{id,type,params}</tool_call>  alternate key names (type → name, params → arguments)
//   <tool name="x">{json}</tool>             name in an attribute
//   <tool id="todo_write">{json}</tool>      tool name in the id attribute
//   <tool><tool ...>{json}</tool></tool>     doubled / nested wrappers
//   <tool id="1"><name>x</name><arguments>{json}</arguments></tool>   XML children
//   <tool:write><parameter name="content" content="...">             parameter style
//   <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash">…             DeepSeek native DSML dialect
//     <｜｜DSML｜｜ parameter name="command">…</…> (full-width ｜ U+FF5C,
//     closers are sloppy: </｜｜DSML｜｜ calls> or bare <｜｜DSML｜｜ invoke>)
//
// A single regex cannot robustly cover all of these (nesting + attributes + XML children),
// so this parser tokenizes the tool tags and walks them with a stack instead. It reuses the
// proven JSON-normalization / fuzzy-name-matching / range-stripping helpers from webTools.js
// rather than duplicating them.

import {
	asRecord,
	finalizeBoundCalls,
	finalizeParsedToolCalls,
	validateToolArguments,
} from "./deepseekWebToolBinding.ts"
import {
	getRequestedToolNames,
	getToolNonce,
	parseLooseJsonObject,
	parseToolCallsFromText,
	resolveRequestedToolName,
	stripRanges,
	toArgumentsString,
} from "./webTools.ts"

export {
	hasMalformedDeepSeekToolIntent,
	hasMalformedDeepSeekToolMarkup,
} from "./deepseekWebToolBinding.ts"

// ── Stricter, compact tool-use prompt ───────────────────────────────────────

/**
 * Serialize an OpenAI `tools` array into a DeepSeek-specific system-prompt block.
 *
 * It is deliberately stricter than the generic `serializeToolsToPrompt`: DeepSeek tends to
 * (a) invent its own wrappers and (b) merely *describe* a plan instead of emitting a call.
 * The wording forces the single canonical `<tool>{json}</tool>` shape and forbids the
 * alternatives, while staying short to avoid wasting tokens.
 *
 * Includes a per-request nonce binding to prevent bare JSON or copy-attacked
 * envelopes from being promoted to tool_calls.
 */
export function serializeDeepSeekToolPrompt(tools) {
	if (!Array.isArray(tools) || tools.length === 0) return ""

	const nonce = getToolNonce(tools)
	if (!nonce) return ""

	const lines = []
	for (const t of tools) {
		const fn = t?.function
		if (!fn?.name) continue
		const desc = typeof fn.description === "string" && fn.description ? fn.description : ""
		let params = ""
		try {
			const schema = asRecord(fn.parameters)
			const properties = asRecord(schema?.properties)
			const required = Array.isArray(schema?.required)
				? schema.required.filter((value) => typeof value === "string")
				: []
			const nonceBoundSchema = schema
				? {
						...schema,
						properties: {
							...(properties ?? {}),
							_nonce: { type: "string", const: nonce },
						},
						required: [...new Set([...required, "_nonce"])],
					}
				: fn.parameters
			params = nonceBoundSchema ? JSON.stringify(nonceBoundSchema) : ""
		} catch {
			params = ""
		}
		lines.push(`- ${fn.name}${desc ? `: ${desc}` : ""}${params ? `\n  parameters: ${params}` : ""}`)
	}
	if (lines.length === 0) return ""

	return [
		"You can call tools. To call a tool, output ONLY this exact block (no markdown fence):",
		`<tool>{"name": "<tool_name>", "arguments": { ... }, "_nonce": "${nonce}"}</tool>`,
		"Rules:",
		"- Use exactly <tool>...</tool>. Do NOT use <tool:name>, <tool_call>, <name>, <parameter>, id=/name= attributes, <｜｜DSML｜｜> markers, or code fences.",
		`- Include the secret binding "_nonce": "${nonce}" exactly as shown.`,
		'- "name" must be one of the tools below; "arguments" must be a JSON object.',
		"- When a tool is needed, emit the <tool> block instead of only describing the plan.",
		"- Emit one <tool> block per call; you may put several blocks back to back.",
		"- If your runtime forces DSML instead, every DSML invoke MUST include this exact binding:",
		`<｜｜DSML｜｜ parameter name="_nonce" string="true">${nonce}</｜｜DSML｜｜ parameter>`,
		"  A DSML invoke without that binding is invalid and will be rejected.",
		"- If no tool is needed, just answer normally without any <tool> block.",
		"",
		"Available tools:",
		...lines,
	].join("\n")
}

// ── Tool-aware conversation prompt ───────────────────────────────────────────

function extractText(content) {
	if (Array.isArray(content)) {
		return content
			.filter((item) => item?.type === "text")
			.map((item) => item?.text ?? "")
			.join("\n")
	}
	return content == null ? "" : String(content)
}

/**
 * Build the single `prompt` string for an agentic (tool-using) DeepSeek-web turn.
 *
 * The web endpoint takes a flat prompt with no `messages[]`, so the legacy `messagesToPrompt`
 * only forwarded the last user message — which makes an agent loop amnesiac: on every turn the
 * follow-up messages carry no new *user* text, so DeepSeek only ever saw the original task and
 * kept restarting (re-creating todos, re-listing files…). This builder instead replays the WHOLE
 * trajectory — including the assistant's prior `<tool>` calls and each `role:"tool"` result — so
 * the model continues from where it left off instead of starting over.
 */
export function buildToolConversationPrompt(messages, toolSystemPrompt) {
	const systemParts = []
	if (toolSystemPrompt) systemParts.push(toolSystemPrompt)

	const lines = []
	const callNameById = new Map()
	let sawToolActivity = false

	for (const m of messages) {
		if (m.role === "system") {
			const t = extractText(m.content).trim()
			if (t) systemParts.push(t)
		} else if (m.role === "user") {
			const t = extractText(m.content).trim()
			if (t) lines.push(`User: ${t}`)
		} else if (m.role === "assistant") {
			const t = extractText(m.content).trim()
			const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
			const parts = []
			if (t) parts.push(t)
			for (const c of calls) {
				const name = typeof c?.function?.name === "string" ? c.function.name : ""
				const rawArgs = c?.function?.arguments
				const args = typeof rawArgs === "string" && rawArgs ? rawArgs : JSON.stringify(rawArgs ?? {})
				if (c?.id) callNameById.set(c.id, name)
				parts.push(`<tool>{"name": ${JSON.stringify(name)}, "arguments": ${args}}</tool>`)
				sawToolActivity = true
			}
			if (parts.length) lines.push(`Assistant: ${parts.join("\n")}`)
		} else if (m.role === "tool") {
			const t = extractText(m.content).trim()
			const name = (m.tool_call_id && callNameById.get(m.tool_call_id)) || m.name || "tool"
			lines.push(`Tool result (${name}): ${t || "(no output)"}`)
			sawToolActivity = true
		}
	}

	const parts = []
	if (systemParts.length) parts.push(systemParts.join("\n\n"))
	if (lines.length) parts.push(lines.join("\n\n"))
	if (sawToolActivity) {
		// Anchor the model to the work already done so it advances instead of repeating it.
		parts.push(
			"Continue the task using the tool results above. Do NOT repeat tool calls that already " +
				"succeeded; perform the next step or give the final answer.",
		)
	}

	return parts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "")
}

// ── Tag tokenizer ────────────────────────────────────────────────────────────

export { parseDeepSeekToolCalls, scrubDsmlDebris } from "./deepseekDsml.ts"
// Matches an opening/closing <tool .../> or <tool_call .../> tag, optionally with a `:name`
// suffix and an attribute list. `tool_call` is listed first so it wins the alternation.
export {
	buildSchemaParamMap,
	extractCall,
	getAttr,
	pairToolBlocks,
	tokenizeToolTags,
} from "./deepseekXmlTags.ts"
