import {
	applyCutRepair,
	collectDsmlTags,
	DSML_ANY_TAG_RE,
	DSML_CUT_TAG_RE,
	DSML_PIPE,
	dsmlBlockEnd,
	hasDsmlTags,
	pairDsmlTags,
	rewriteCutDsmlTags,
} from "./deepseekDsmlRepair.ts"
import {
	asRecord,
	finalizeBoundCalls,
	finalizeParsedToolCalls,
	validateToolArguments,
} from "./deepseekWebToolBinding.ts"
import {
	buildSchemaParamMap,
	extractCall,
	getAttr,
	pairToolBlocks,
	tokenizeToolTags,
} from "./deepseekXmlTags.ts"
import {
	getRequestedToolNames,
	getToolNonce,
	parseLooseJsonObject,
	parseToolCallsFromText,
	resolveRequestedToolName,
	stripRanges,
	toArgumentsString,
} from "./webTools.ts"

const DSML_MARK = `${DSML_PIPE}{2}DSML${DSML_PIPE}{2}`

// A DSML marker is model-internal bookkeeping, never assistant prose. Whatever the dialect
// parsers did not consume — an envelope whose closer never arrived, a stream cut mid-invoke, a
// rejected nonce binding, the single-pipe spelling — must not travel to the client: on the
// Anthropic protocol it arrives as a `text` block full of markers with `stop_reason: end_turn`,
// so the client runs nothing and the turn stalls. Scrubbed at the parser's boundary, once, for
// every shape and every exit.
const DSML_DEBRIS_RE =
	/<\/?(?:｜｜|\|\|?)DSML(?:｜｜|\|\|?)\s*(?:calls|call|invoke|parameter|tool_calls|function_calls)\b[^>]*>/gi
const EMPTY_FENCE_RE = /```[a-zA-Z]*[ \t]*\n?[ \t]*```/g

export function scrubDsmlDebris(content) {
	if (typeof content !== "string") return content
	// An empty fence is always the leftover of a stripped block, never something the model wrote.
	const unFenced = content.replace(EMPTY_FENCE_RE, "")
	if (!unFenced.includes("DSML")) return unFenced.trim()
	return unFenced
		.replace(DSML_DEBRIS_RE, "")
		.replace(/[ 	]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

export function buildDsmlCall(open, close, text, requested, synth) {
	const rawName = getAttr(open.attrs, "name")
	if (!rawName) return null // stray closer or nameless invoke — ignore
	const { innerEnd, stripEnd } = dsmlBlockEnd(open, close, text)
	const inner = text.slice(open.end, innerEnd)
	const ptags = collectDsmlTags(inner, "parameter", open.end)
	const args = {}
	// End of the last consumed parameter: when the invoke has no closing tag,
	// the strip range ends here instead of swallowing trailing legitimate text.
	let consumedEnd = open.end
	for (const [pOpen, pClose] of pairDsmlTags(ptags)) {
		const pName = getAttr(pOpen.attrs, "name")
		if (!pName) continue
		const pEnd = pClose ? pClose.start : innerEnd
		// Multiline-safe: value is everything up to the next parameter tag.
		// Auxiliary attributes (string="true", …) are ignored; a content="…"
		// attribute is only a fallback when the body is empty.
		let rawBody = text.slice(pOpen.end, pEnd)
		// A `>` the repair put back closes the tag, it does not open the value: reading it as one
		// turned every cut parameter into the literal `">"`.
		for (const at of synth) {
			if (at >= pOpen.end && at < pEnd) rawBody = rawBody.replace(">", "")
		}
		rawBody = rawBody.trim()
		if (rawBody === "") rawBody = getAttr(pOpen.attrs, "content") ?? ""
		// A body that opened a DSML tag the stream then cut is not a value: it is the makings of
		// another parameter, and taking it whole turns the `{` or the marker into the argument.
		const cutAt = rawBody.search(DSML_CUT_TAG_RE)
		if (cutAt !== -1) rawBody = rawBody.slice(0, cutAt).trim()
		// `<parameter name="arguments">{"command":"ls"}</parameter>` carries the call's whole
		// argument object under a wrapper key; the tool's own schema is keyed by the fields.
		if (pName === "arguments" && rawBody.startsWith("{")) {
			const parsed = parseLooseJsonObject(rawBody)
			if (parsed) {
				const { _nonce: _boundNonce, ...rest } = parsed
				Object.assign(args, rest)
				consumedEnd = pClose ? pClose.end : stripEnd
				continue
			}
		}
		args[pName] = rawBody
		consumedEnd = pClose ? pClose.end : stripEnd
	}
	// Fail-safe: without at least one non-empty argument value the call is ambiguous (empty invoke,
	// nameless/valueless parameters) — skip it rather than emit a partially-built call. A truncation
	// is the one exception: the tag the stream cut is a parameter the reply DID declare, so the call
	// keeps its name and the client can reject it on the schema instead of reading markup as prose.
	const cutByStream = synth.size > 0
	if (!Object.values(args).some((v) => v !== "") && !(cutByStream && Object.keys(args).length > 0))
		return null
	const name = resolveRequestedToolName(rawName, requested) ?? rawName
	return { start: open.start, end: close ? close.end : consumedEnd, name, args }
}

export function parseDsmlBlocks(text, requested) {
	const out = []
	const strip = []
	// A tag the stream cut before its `>` is one the tag scanner cannot see; the strict dialects
	// below would "read" it — and claim the turn with an empty call. Closing it here keeps the one
	// call the reply really declared on the path that recovers its arguments.
	const repairs = rewriteCutDsmlTags(text)
	// The `>` the repair put back is not something the model wrote: it must never become the value
	// of the parameter whose tag the stream cut.
	const synth = new Set()
	if (repairs.length > 0) {
		const applied = applyCutRepair(text, repairs)
		text = applied.text
		for (const at of applied.inserted) synth.add(at)
	}
	const callsRe = new RegExp(
		`<${DSML_MARK}\\s*calls\\s*>([\\s\\S]*?)(?:</${DSML_MARK}\\s*calls\\s*>|<${DSML_MARK}\\s*/\\s*calls\\s*>)`,
		"gi",
	)
	const closeRe = new RegExp(
		`(?:</${DSML_MARK}\\s*calls\\s*>|<${DSML_MARK}\\s*/\\s*calls\\s*>)\\s*$`,
		"i",
	)
	const envelopeRanges = []
	let cm = null
	while ((cm = callsRe.exec(text)) !== null) {
		const envelope = { start: cm.index, end: callsRe.lastIndex }
		envelopeRanges.push(envelope)
		const body = cm[1]
		const bodyBase = cm.index + cm[0].indexOf(body)
		const closeM = closeRe.exec(cm[0])
		strip.push({ start: cm.index, end: bodyBase })
		strip.push({
			start: cm.index + (closeM ? closeM.index : cm[0].length),
			end: cm.index + cm[0].length,
		})
		// A block that never closed is bounded by the end of the reply, not by the envelope's
		// own closer: look its parameter tags up in the whole text so they are found.
		for (const [openTag, closeTag] of pairDsmlTags(collectDsmlTags(body, "invoke", bodyBase))) {
			const call = buildDsmlCall(openTag, closeTag, text, requested, synth)
			if (call) out.push(call)
		}
	}
	// Bare root-level invokes outside any envelope convert identically.
	// Tags already consumed inside envelopes are excluded so nothing is parsed twice.
	const rootTags = collectDsmlTags(text, "invoke", 0).filter(
		(t) => !envelopeRanges.some((r) => t.start >= r.start && t.end <= r.end),
	)
	for (const [openTag, closeTag] of pairDsmlTags(rootTags)) {
		const call = buildDsmlCall(openTag, closeTag, text, requested, synth)
		if (call) out.push(call)
	}
	return { calls: out.sort((a, b) => a.start - b.start), strip }
}

// ── DSML invoke-markup normalization ────────────────────────────────────────
//
// Some DeepSeek-web harness builds emit tool calls wrapped in a different, well-formed
// grammar using doubled full-width-pipe "DSML" namespace markers with space-separated
// structural words instead of the `<tool>`/`<tool_call>` vocabulary above.
// Neither TAG_TOKEN_RE above nor the generic single-pipe normalizer recognize this
// double-pipe shape. Rather than teach every downstream consumer this namespace, rewrite
// it into the canonical `<tool>`/`<parameter>` tags this file's own tokenizer already
// understands, before tokenization runs.
const DSML_INVOKE_OPEN_RE = /<[｜|]{1,2}DSML[｜|]{1,2}\s+(calls|invoke|parameter)([^>]*)>/gi
const DSML_INVOKE_CLOSE_RE = /<\/[｜|]{1,2}DSML[｜|]{1,2}\s+(calls|invoke|parameter)\s*>/gi

export function normalizeDsmlInvokeMarkup(text) {
	if (!text.includes("DSML")) return text

	const withOpens = text.replace(DSML_INVOKE_OPEN_RE, (_full, word, attrs) => {
		const tag = word.toLowerCase()
		if (tag === "calls") return ""
		const name = getAttr(attrs, "name")
		const nameAttr = name !== null ? ` name="${name}"` : ""
		return tag === "invoke" ? `<tool${nameAttr}>` : `<parameter${nameAttr}>`
	})

	return withOpens.replace(DSML_INVOKE_CLOSE_RE, (_full, word) => {
		const tag = word.toLowerCase()
		if (tag === "calls") return ""
		return tag === "invoke" ? "</tool>" : "</parameter>"
	})
}

// Rewrites the tip's DSML / bare-<parameter> dialects into the canonical `<tool>` / `<parameter>`
// vocabulary the tokenizer understands. Skipped when the native DSML parser above already
// extracted calls from the original text (its sloppy-closer handling needs the raw markers).
export function normalizeDeepSeekMarkup(text) {
	text = normalizeDsmlInvokeMarkup(text)

	// Normalize DeepSeek V4 DSML markup (<｜｜DSML｜｜ ...>) only when markers are present,
	// preserving original whitespace formatting on plain non-tool replies.
	if (
		/[｜|]{1,2}DSML[｜|]{1,2}/i.test(text) ||
		/<parameter\b/i.test(text) ||
		/<\/(?:parameter|invoke|arguments|calls|tool_calls|function_calls)>/i.test(text) ||
		text.includes("This response is AI-generated, for reference only.")
	) {
		// Clean trailing provider disclaimer (anchored to the end of the text to protect argument values)
		text = text.replace(/\s*This response is AI-generated, for reference only\.\s*$/i, "")
		text = text
			.replace(/<\/?(?:[｜|]{1,2})DSML(?:[｜|]{1,2})\s*(?:calls|tool_calls|function_calls)>/gi, "")
			.replace(/<(\/?)(?:(?:[｜|]{1,2})DSML(?:[｜|]{1,2})\s*)?invoke\b/gi, "<$1tool")
			.replace(/<(\/?)(?:(?:[｜|]{1,2})DSML(?:[｜|]{1,2})\s*)?parameter\b/gi, "<$1parameter")
			.replace(/(}\s*)<\/(?:parameter|invoke|calls|tool_calls|function_calls)>/gi, "$1")

		// If model emitted bare <parameter> tags without enclosing <tool> or <invoke>
		if (/<parameter\b/i.test(text) && !/<tool\b/i.test(text)) {
			text = text.replace(/((?:<parameter\b[\s\S]*?<\/parameter>\s*)+)/gi, "<tool>$1</tool>")
		}
	}
	return text
}

// WMAdapter-compatible native DeepSeek output. DeepSeek has emitted both the
// printable ASCII token spelling and the full-width tokenizer spelling. Keep
// this parser separate from the generic XML-like parser. It is applied to
// every DeepSeek request carrying OpenAI-compatible tools[], regardless of
// which client/agent initiated the request. Malformed or unknown native output
// must remain visible and must never be promoted by a fallback.
const DSML_INVOKE_RE =
	/<(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))invoke\b([^>]*)>([\s\S]*?)<\/(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))invoke\s*>/gi
const DSML_PARAMETER_RE =
	/<(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))parameter\b([^>]*)>([\s\S]*?)(?:<\/(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))parameter\s*>|<(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))parameter\s*>)/gi
const DSML_TOKEN_RE =
	/<(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))(?:calls|call|invoke|parameter)\b[^>]*>(?:.|\n)*?<\/(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))(?:calls|call|invoke|parameter)\s*>/i

const NATIVE_TOOL_CALL_TOKEN_RE =
	/(?:<\|tool_call_begin\|>|<｜tool▁call▁begin｜>)[\s\n]*([^<\s]+)[\s\n]*(?:<\|tool_call_argument_begin\|>|<｜tool▁call▁argument▁begin｜>)([\s\S]*?)(?:<\|tool_call_argument_end\|>|<｜tool▁call▁argument▁end｜>)[\s\n]*(?:<\|tool_call_end\|>|<｜tool▁call▁end｜>)/g

/**
 * Parse the printable-ASCII / full-width `<|tool_call_begin|>...` native token
 * shape, appending any recognized calls (and their source ranges) in place.
 */
export function collectNativeToolCallTokens(
	text,
	idSeed,
	requested,
	requestedTools,
	calls,
	ranges,
) {
	NATIVE_TOOL_CALL_TOKEN_RE.lastIndex = 0
	let nativeMatch = null
	while ((nativeMatch = NATIVE_TOOL_CALL_TOKEN_RE.exec(text)) !== null) {
		const resolved = resolveRequestedToolName(nativeMatch[1], requested)
		const parsed = parseJsonOrNull(nativeMatch[2].trim())
		if (!resolved || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
		const normalized = normalizeDeepSeekNativeArguments(parsed, resolved, requestedTools)
		calls.push({
			id: `${idSeed}_${calls.length}`,
			type: "function",
			function: { name: resolved, arguments: JSON.stringify(normalized) },
		})
		ranges.push({ start: nativeMatch.index, end: nativeMatch.index + nativeMatch[0].length })
	}
}

export function parseJsonOrNull(raw) {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

/** Parse one `<invoke name="x"><parameter name="y">...</parameter></invoke>` block's args. */
export function collectDsmlInvokeParameters(body) {
	const args = {}
	let found = false
	DSML_PARAMETER_RE.lastIndex = 0
	let parameterMatch = null
	while ((parameterMatch = DSML_PARAMETER_RE.exec(body)) !== null) {
		const parameterName = getAttr(parameterMatch[1] || "", "name")
		if (!parameterName) continue
		const raw = parameterMatch[2].trim()
		args[parameterName] = parseJsonOrNull(raw) ?? raw
		found = true
	}
	return { args, found }
}

/**
 * Parse the `<DSML|invoke name="x">...</DSML|invoke>` shape, appending any
 * recognized calls (and their source ranges) in place.
 */
export function collectDsmlInvokeCalls(text, idSeed, requested, requestedTools, calls, ranges) {
	DSML_INVOKE_RE.lastIndex = 0
	let match = null
	while ((match = DSML_INVOKE_RE.exec(text)) !== null) {
		const name = getAttr(match[1] || "", "name")
		const resolved = name ? resolveRequestedToolName(name, requested) : null
		if (!resolved) continue
		const { args, found } = collectDsmlInvokeParameters(match[2])
		// An invoke with no parameters is valid; a malformed body is not.
		if (!found && match[2].trim()) continue
		const normalized = normalizeDeepSeekNativeArguments(args, resolved, requestedTools)
		calls.push({
			id: `${idSeed}_${calls.length}`,
			type: "function",
			function: { name: resolved, arguments: JSON.stringify(normalized) },
		})
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}
}

/** Extend a recognized call's stripped range to cover its enclosing `<DSML|calls>` wrapper. */
export function extendRangesForDsmlWrapper(text, ranges) {
	const wrapperRe =
		/<(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))calls\s*>[\s\S]*?<\/(?:(?:\|DSML\|)|(?:｜｜DSML｜｜))calls\s*>/gi
	let wrapper = null
	while ((wrapper = wrapperRe.exec(text)) !== null) {
		const start = wrapper.index
		const end = start + wrapper[0].length
		if (ranges.some((range) => range.start >= start && range.end <= end)) ranges.push({ start, end })
	}
}

export function parseNativeDeepSeekCalls(text, idSeed, requestedTools) {
	const requested = getRequestedToolNames(requestedTools)
	const calls = []
	const ranges = []
	collectNativeToolCallTokens(text, idSeed, requested, requestedTools, calls, ranges)
	collectDsmlInvokeCalls(text, idSeed, requested, requestedTools, calls, ranges)
	if (calls.length > 0) extendRangesForDsmlWrapper(text, ranges)
	const recognized = DSML_TOKEN_RE.test(text) || /<(?:(?:\|tool_call_)|(?:｜tool▁call▁))/.test(text)
	if (calls.length === 0) return { content: text, toolCalls: null, recognized }
	return { content: stripRanges(text, ranges), toolCalls: calls, recognized }
}

export function normalizeDeepSeekNativeArguments(args, name, tools) {
	// Schema-guided string coercion locally, without changing the generic web-tools behavior.
	const tool = Array.isArray(tools) ? tools.find((t) => t?.function?.name === name) : undefined
	const properties = tool?.function?.parameters?.properties
	if (!properties || typeof properties !== "object") return args
	for (const [key, value] of Object.entries(args)) {
		if (properties[key]?.type === "string" && typeof value !== "string")
			args[key] = JSON.stringify(value)
	}
	return args
}

// ── Public parser ─────────────────────────────────────────────────────────────

/**
 * Parse a DeepSeek-web text reply into OpenAI `tool_calls`. Returns the surrounding text
 * with the recognized blocks stripped (so it can still be streamed to the client) plus the
 * parsed calls, or `null` when none are present.
 *
 * The content leaving this function never carries DSML markers: a reply whose call could not be
 * rebuilt still loses its markup (see `scrubDsmlDebris`), so a client is never handed a text
 * block full of model-internal syntax.
 */
export function parseDeepSeekToolCalls(text, idSeed = "call", requestedTools) {
	const parsed = parseDeepSeekDialects(text, idSeed, requestedTools)
	return { ...parsed, content: scrubDsmlDebris(parsed.content) }
}

/**
 * Classify the reply by dialect and rebuild the calls it declares. Falls back to the canonical
 * `webTools.parseToolCallsFromText` for tag-free replies so that bare-JSON and plain `<tool>`
 * behavior stays identical to the shared implementation.
 */
export function parseDeepSeekDialects(text, idSeed = "call", requestedTools) {
	if (typeof text !== "string" || text.length === 0) {
		return { content: text ?? "", toolCalls: null }
	}

	// Trailing provider disclaimer would otherwise leak into the last DSML parameter value
	// (the normalizing path strips the same suffix; doing it once up front is equivalent).
	text = text.replace(/\s*This response is AI-generated, for reference only\.\s*$/i, "")

	const requested = getRequestedToolNames(requestedTools)
	// Upstream's double-pipe DSML dialect first, on the ORIGINAL text: real replies close blocks
	// sloppily (`<｜｜DSML｜｜ invoke>` with no slash), which normalizeDsmlInvokeMarkup would turn into
	// unbalanced `<tool>` opens. When it yields no calls, fall through to this fork's dialects.
	const dsmlParsed = hasDsmlTags(text) ? parseDsmlBlocks(text, requested) : null
	const dsml = dsmlParsed && dsmlParsed.calls.length > 0 ? dsmlParsed : null
	if (!dsml) {
		// Dialects upstream's double-pipe parser does not claim: the single-pipe ASCII |DSML| form
		// (with string="" attributes) and the WMAdapter ▁-token spelling. Only a dialect that
		// actually RECOVERED a call may answer for the reply. A merely recognised result used to
		// claim the turn and hand the markup back as prose — which leaked the markers to the client
		// and hid both the other dialect and the <tool>/salvage path behind it.
		const recovered = (r) => (r.toolCalls?.length ?? 0) > 0

		const forkDsml = parseFullWidthDsmlCalls(text, idSeed, requestedTools)
		if (recovered(forkDsml)) return finalizeParsedToolCalls(text, forkDsml, requestedTools)

		// An invoke that failed its nonce binding is a rejected call, not prose to re-parse: the
		// reply keeps its text (the boundary scrubs the markup) and no fallback promotes it.
		if (forkDsml.rejected) return { content: text, toolCalls: null }

		const native = parseNativeDeepSeekCalls(text, idSeed, requestedTools)
		// Same dialect, same policy as the double-pipe blocks above: these carry no `_nonce` to
		// bind, so `finalizeBoundCalls` (not the schema-validating variant) is the matching gate —
		// an argument the model typed as a string is still the call it declared.
		if (recovered(native)) return finalizeBoundCalls(text, native, requestedTools)
		text = normalizeDeepSeekMarkup(text)
	}

	const tokens = tokenizeToolTags(text)
	if (tokens.length === 0 && !dsml) {
		// No DeepSeek-specific tags — defer to the proven canonical parser (bare JSON, etc.).
		return finalizeParsedToolCalls(
			text,
			parseToolCallsFromText(text, idSeed, requestedTools),
			requestedTools,
		)
	}

	const schemaMap = buildSchemaParamMap(requestedTools)
	const blocks = pairToolBlocks(tokens, text.length)

	// Only extract from leaf blocks (no other block nested inside), so a doubled
	// `<tool><tool>...</tool></tool>` wrapper yields a single call from the inner block.
	const isLeaf = (b) =>
		!blocks.some((o) => o !== b && o.open.start >= b.innerStart && o.close.end <= b.innerEnd)

	const found = []
	const nonce = getToolNonce(requestedTools)

	for (const block of blocks.filter(isLeaf).sort((a, b) => a.open.start - b.open.start)) {
		const tagName =
			block.open.suffix || getAttr(block.open.attrs, "name") || getAttr(block.open.attrs, "id") || ""
		const inner = text.slice(block.innerStart, block.innerEnd).replace(DSML_ANY_TAG_RE, "")
		const call = extractCall(tagName, inner, requested, schemaMap)
		if (!call) continue

		// Nonce binding check: canonical JSON-body tool blocks (where the inner
		// text is JSON with a "name" field) that carry an explicit _nonce must match the
		// per-request binding. A wrong nonce means this is a copy-attack or hallucination.
		//
		// XML children (<parameter>, <name>, <arguments>) and tag-suffix blocks do not
		// have a JSON body, so the nonce check does not apply to them.
		// A missing _nonce is tolerated for backward compatibility.
		if (nonce) {
			const parsed = parseLooseJsonObject(inner)
			if (
				parsed &&
				typeof parsed.name === "string" &&
				parsed._nonce !== undefined &&
				parsed._nonce !== nonce
			)
				continue
		}

		found.push({
			start: block.open.start,
			end: block.close.end,
			call,
		})
	}

	// Native DSML dialect (no nonce concept — same policy as the XML/tag-suffix
	// shapes, which likewise carry no JSON body to bind).
	let dsmlStrip = []
	if (dsml) {
		dsmlStrip = dsml.strip
		for (const d of dsml.calls) {
			found.push({
				start: d.start,
				end: d.end,
				call: { name: d.name, arguments: toArgumentsString(d.args) },
			})
		}
	}

	if (found.length === 0) {
		// Tags were present but none parsed (e.g. malformed or nonce-rejected).
		// Do NOT fall back to parseToolCallsFromText — that would re-process content
		// already seen by this parser and potentially promote rejected tagged output
		// to tool_calls.
		return { content: text, toolCalls: null }
	}

	// Document order across both dialects so mixed DSML + <tool> replies keep a
	// stable, deterministic id sequence.
	found.sort((a, b) => a.start - b.start)
	const toolCalls = []
	const acceptedRanges = []
	for (const f of found) {
		toolCalls.push({
			id: `${idSeed}_${toolCalls.length}`,
			type: "function",
			function: { name: f.call.name, arguments: f.call.arguments },
		})
		acceptedRanges.push({ start: f.start, end: f.end })
	}

	// Strip the accepted blocks plus any stray tool tags left outside them (the unmatched outer
	// `<tool>` of a doubled wrapper, leftover `</tool>` of a non-leaf wrapper, etc.).
	// DSML wrapper tags are stripped via dsmlStrip (invoke ranges already cover
	// the calls they belong to).
	const within = (tok) => acceptedRanges.some((r) => tok.start >= r.start && tok.end <= r.end)
	const ranges = [
		...acceptedRanges,
		...dsmlStrip,
		...tokens.filter((t) => !within(t)).map((t) => ({ start: t.start, end: t.end })),
	]

	let content = stripRanges(text, ranges)
	if (toolCalls.length > 0) {
		content = content
			.replace(/<parameter\b[^>]*>[\s\S]*?(?:<\/parameter>|$)/gi, "")
			.replace(/<\/?(?:parameter|invoke|tool|calls|tool_calls|function_calls)\b[^>]*>/gi, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	}

	return finalizeBoundCalls(text, { content, toolCalls }, requestedTools)
}

/**
 * DeepSeek Web sometimes emits its internal full-width DSML envelope instead of the
 * requested `<tool>{json}</tool>` contract. Convert every invocation in the envelope to
 * an OpenAI tool call. This is deliberately separate from the generic tag parser because
 * the DSML delimiters contain full-width Unicode characters and may contain several calls
 * in one response.
 */
/** Parse a full-width-DSML invoke body's `<parameter>` children, falling back to bare JSON. */
export function extractFullWidthDsmlArgs(body): Record<string, unknown> {
	const args: Record<string, unknown> = {}
	const paramRe =
		/<(?:｜｜DSML｜｜|\|DSML\|)\s*parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/?(?:｜｜DSML｜｜|\|DSML\|)\s*parameter\s*>|(?=<(?:｜｜DSML｜｜|\|DSML\|)\s*parameter\s+name=|<\/(?:｜｜DSML｜｜|\|DSML\|)\s*invoke\s*>))/g
	let param = null
	while ((param = paramRe.exec(body)) !== null) {
		const raw = param[2].trim()
		args[param[1]] = parseJsonOrNull(raw) ?? raw
	}
	if (Object.keys(args).length > 0) return args

	// No <parameter> children: the whole body may itself be a bare JSON object.
	const parsed = parseJsonOrNull(body.trim() || "{}")
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(args, parsed)
	return args
}

export function parseFullWidthDsmlCalls(text, idSeed, requestedTools) {
	const marker = /<(?:(?:｜｜DSML｜｜)|(?:\|DSML\|))/
	if (!marker.test(text))
		return { content: text, toolCalls: null, recognized: false, rejected: false }

	const requested = getRequestedToolNames(requestedTools)
	const nonce = getToolNonce(requestedTools)
	const calls = []
	const ranges = []
	const invokeRe =
		/<(?<dsml>｜｜DSML｜｜|\|DSML\|)\s*invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/\k<dsml>\s*invoke\s*>/g
	let match = null
	// A well-formed `invoke name="...">...</invoke>` pair marks the response as a genuine
	// (if possibly unresolved) DSML tool call, distinct from stray/corrupted DSML delimiter
	// debris trailing an unrelated block — only the former should block the canonical
	// `<tool>`/salvage fallback below.
	let sawInvokeTag = false
	let rejectedInvoke = false
	while ((match = invokeRe.exec(text)) !== null) {
		sawInvokeTag = true
		const resolvedName = resolveRequestedToolName(match[2], requested)
		if (!resolvedName) {
			rejectedInvoke = true
			continue
		}
		const parsedArgs = extractFullWidthDsmlArgs(match[3])
		const nestedArgs = asRecord(parsedArgs.arguments)
		const emittedNonce = parsedArgs._nonce ?? nestedArgs?._nonce
		// A nonce that is present and wrong is a call the model copied instead of making, so the
		// turn is rejected. An ABSENT nonce is not: the double-pipe spelling of this same dialect
		// carries none and is promoted by parseDsmlBlocks above, and demanding one here is what
		// left every plain `|DSML|` reply as prose.
		if (emittedNonce !== undefined && emittedNonce !== nonce) {
			rejectedInvoke = true
			continue
		}
		let args
		if (nestedArgs) {
			const { _nonce: _boundNonce, ...rest } = nestedArgs
			args = rest
		} else {
			const { _nonce: _boundNonce, name: _redundantName, ...rest } = parsedArgs
			args = rest
		}
		// Only a bound call is held to its schema, matching finalizeBoundCalls: an unbound invoke
		// is the lenient dialect, where an argument the model typed as a string is still the call
		// it declared.
		if (emittedNonce !== undefined && !validateToolArguments(requestedTools, resolvedName, args)) {
			rejectedInvoke = true
			continue
		}
		calls.push({
			id: `${idSeed}_${calls.length}`,
			type: "function",
			function: { name: resolvedName, arguments: JSON.stringify(args) },
		})
		ranges.push({ start: match.index, end: invokeRe.lastIndex })
	}

	// A rejected invoke is dropped on its own, not as the whole reply: a hallucinated tool name or a
	// copied binding must not cost the calls the reply did declare. Only a reply that recovered
	// nothing is marked rejected, which is what keeps a fallback from promoting it.
	if (calls.length === 0) {
		return { content: text, toolCalls: null, recognized: sawInvokeTag, rejected: rejectedInvoke }
	}

	const callsEnvelope = /<\/?(?:｜｜DSML｜｜|\|DSML\|)\s*calls\s*>/g
	let envelope = null
	while ((envelope = callsEnvelope.exec(text)) !== null) {
		ranges.push({ start: envelope.index, end: callsEnvelope.lastIndex })
	}
	return { content: stripRanges(text, ranges), toolCalls: calls, recognized: true, rejected: false }
}
