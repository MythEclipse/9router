import { finalizeBoundCalls } from "./deepseekWebToolBinding.ts"
import { parseLooseJsonObject, resolveRequestedToolName, toArgumentsString } from "./webTools.ts"

export const TAG_TOKEN_RE = /<(\/?)(?:tool_call|tool)(:[A-Za-z0-9_.+-]+)?((?:\s[^>]*)?)\/?>/g

export function tokenizeToolTags(text) {
	const tokens = []
	let m = null
	TAG_TOKEN_RE.lastIndex = 0
	while ((m = TAG_TOKEN_RE.exec(text)) !== null) {
		tokens.push({
			start: m.index,
			end: TAG_TOKEN_RE.lastIndex,
			closing: m[1] === "/",
			suffix: m[2] ? m[2].slice(1) : "",
			attrs: m[3] || "",
		})
	}
	return tokens
}

// Pair tags with a stack: every closing tag pairs with the nearest unmatched open. An open
// left unmatched at the end (e.g. the stray outer `<tool>` of a doubled wrapper, or a
// never-closed `<tool:write>` followed by `<parameter ...>`) gets a synthetic close at the end
// of the text so its body is still parsed; the doubled-wrapper outer is then dropped by the
// leaf filter.
export function pairToolBlocks(tokens, textLen) {
	const blocks = []
	const stack = []
	for (const tok of tokens) {
		if (!tok.closing) {
			stack.push(tok)
			continue
		}
		const open = stack.pop()
		if (!open) continue
		blocks.push({ open, close: tok, innerStart: open.end, innerEnd: tok.start })
	}
	for (const open of stack) {
		const synthetic = {
			start: textLen,
			end: textLen,
			closing: true,
			suffix: "",
			attrs: "",
		}
		blocks.push({ open, close: synthetic, innerStart: open.end, innerEnd: textLen })
	}
	return blocks
}

// ── Attribute / XML-child helpers ────────────────────────────────────────────

/** Read an attribute value, tolerating backslash-escaped quotes inside the value. */
export function getAttr(attrs, name) {
	const re = new RegExp(`\\b${name}\\s*=\\s*("|')`)
	const m = re.exec(attrs)
	if (!m) return null
	const quote = m[1]
	let j = m.index + m[0].length
	let out = ""
	while (j < attrs.length) {
		const ch = attrs[j]
		if (ch === "\\") {
			out += attrs[j + 1] ?? ""
			j += 2
			continue
		}
		if (ch === quote) break
		out += ch
		j += 1
	}
	return out
}

export function getXmlChild(inner, tag) {
	const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(inner)
	return m ? m[1].trim() : null
}

// The body group is a tempered greedy token: `(?:(?!<parameter\b)[\s\S])*?` so an
// attribute-only `<parameter ...>` (no closing tag) cannot let the body matcher swallow a
// following `<parameter>...</parameter>` and drop that parameter.
export const PARAM_TAG_RE =
	/<parameter\b([^>]*?)\/?>(?:((?:(?!<parameter\b)[\s\S])*?)<\/parameter>)?/gi

/** Collect `<parameter name="x" content="y">` / `<parameter name="x">y</parameter>` into an object. */
export function buildArgsFromParameters(inner) {
	const out = {}
	let found = false
	let m = null
	PARAM_TAG_RE.lastIndex = 0
	while ((m = PARAM_TAG_RE.exec(inner)) !== null) {
		const attrs = m[1] || ""
		const body = m[2]
		const name = getAttr(attrs, "name")
		if (!name) continue
		const value = getAttr(attrs, "content") ?? (typeof body === "string" ? body.trim() : "")
		out[name] = value
		found = true
	}
	return found ? out : null
}

// ── Single-block extraction ──────────────────────────────────────────────────

export function asString(value) {
	return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Build a map of tool name → set of parameter property keys from the requested tools array.
 * Used by the nameless-block fallback to do conservative schema-based name resolution.
 */
export function buildSchemaParamMap(requestedTools) {
	const map = new Map()
	if (!Array.isArray(requestedTools)) return map
	for (const tool of requestedTools) {
		const fn = tool?.function
		if (!fn?.name) continue
		const params = fn.parameters
		const props = params?.properties
		if (props && typeof props === "object" && !Array.isArray(props)) {
			map.set(fn.name, new Set(Object.keys(props)))
		} else {
			map.set(fn.name, new Set())
		}
	}
	return map
}

// DeepSeek's web session occasionally leaks malformed/internal formatting tokens right
// after an otherwise-complete JSON tool call body (observed in production: a valid
// `{"name": ..., "arguments": {...}}` object immediately followed by corrupted
// pseudo-tags instead of a clean `</tool>` close). `parseLooseJsonObject` uses a strict
// `JSON.parse`, which rejects the whole string over that trailing garbage even though a
// perfectly valid object sits right at the start. This scans for the first balanced
// `{...}` object (quote/escape aware) and returns just that slice, so it can still be
// parsed on its own.
export function salvageLeadingJsonObject(text) {
	const start = text.indexOf("{")
	if (start === -1) return null
	let depth = 0
	let quote = ""
	let escaped = false
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i]
		if (escaped) {
			escaped = false
			continue
		}
		if (quote) {
			if (ch === "\\") escaped = true
			else if (ch === quote) quote = ""
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			continue
		}
		if (ch === "{") {
			depth += 1
			continue
		}
		if (ch === "}") {
			depth -= 1
			if (depth === 0) return text.slice(start, i + 1)
		}
	}
	return null // never balanced — genuinely truncated, nothing to salvage
}

/**
 * Turn one tool block (tag name + inner text) into a name + JSON-string arguments.
 * Returns null when no plausible tool name can be recovered.
 */
export function extractCall(tagName, innerRaw, requested, schemaMap) {
	const inner = innerRaw.trim()

	const nameChild = getXmlChild(inner, "name")
	const argsChild = getXmlChild(inner, "arguments") ?? getXmlChild(inner, "parameters")
	const paramObj = argsChild ? null : buildArgsFromParameters(inner)
	const hasXmlChildren = !!nameChild || !!argsChild || !!paramObj

	let json = hasXmlChildren ? null : parseLooseJsonObject(inner)
	if (!json && !hasXmlChildren) {
		// Strict parse failed — try salvaging a complete JSON object from the start of the
		// block even if trailing content after it is malformed (see salvageLeadingJsonObject).
		const salvaged = salvageLeadingJsonObject(inner)
		if (salvaged) json = parseLooseJsonObject(salvaged)
	}
	const jsonName = json ? (asString(json.name) ?? asString(json.type)) : null

	const childResolved = nameChild ? resolveRequestedToolName(nameChild, requested) : null
	const jsonResolved = jsonName ? resolveRequestedToolName(jsonName, requested) : null
	const tagResolved = tagName ? resolveRequestedToolName(tagName, requested) : null

	// Prefer a name that maps to a requested tool. The JSON body wins over the tag attribute
	// because DeepSeek sometimes emits a bogus tag name (e.g. name="skill").
	let name = null
	let nameFromTag = false
	const pick = (val, fromTag) => {
		if (!name && val) {
			name = val
			nameFromTag = fromTag
		}
	}
	pick(childResolved, false)
	pick(jsonResolved, false)
	pick(tagResolved, true)
	pick(nameChild, false)
	pick(jsonName, false)
	pick(tagName, true)

	// Shell-style `{ "command": "..." }` with no tag name: treat command as the tool name only
	// if it actually resolves to a requested tool (the value is otherwise the command itself).
	if (!name && !tagName && json) {
		const command = asString(json.command)
		const resolved = command ? resolveRequestedToolName(command, requested) : null
		if (resolved) {
			name = resolved
			nameFromTag = false
		}
	}

	// Nameless-block fallback: when all explicit name-resolution paths fail but the
	// block has <parameter> children, try a conservative schema-based match. If exactly ONE
	// requested tool's parameter-schema keys are a superset of every extracted param name,
	// adopt that tool name. Zero matches or ambiguous (>1) → keep returning null to avoid
	// misattributing calls.
	if (!name && paramObj && schemaMap && schemaMap.size > 0) {
		const extractedKeys = Object.keys(paramObj)
		if (extractedKeys.length > 0) {
			const candidates = []
			for (const [toolName, schemaKeys] of schemaMap) {
				if (schemaKeys.size > 0 && extractedKeys.every((k) => schemaKeys.has(k))) {
					candidates.push(toolName)
				}
			}
			if (candidates.length === 1) {
				name = candidates[0]
				nameFromTag = false
			}
		}
	}

	if (!name) return null

	let argsValue
	if (argsChild) {
		argsValue = parseLooseJsonObject(argsChild) ?? argsChild
	} else if (paramObj) {
		argsValue = paramObj
	} else if (json) {
		if (json.arguments !== undefined) argsValue = json.arguments
		else if (json.params !== undefined) argsValue = json.params
		else if (nameFromTag) {
			// `<tool:bash>{"command": ...}` — the whole JSON object is the arguments payload.
			argsValue = json
		} else {
			// Name came from the JSON body — the remaining keys are the arguments.
			const { name: _n, type: _t, id: _i, command: _c, arguments: _a, params: _p, ...rest } = json
			argsValue = rest
		}
	} else {
		argsValue = {}
	}

	return { name, arguments: toArgumentsString(argsValue) }
}

// ── DeepSeek native DSML dialect ─────────────────────────────────────────────
// The web model sometimes ignores the `<tool>` contract above and emits its
// native pretraining-time tool dialect instead (observed live — without this
// the reply degrades to plain text and the client never executes anything):
//   <｜｜DSML｜｜ calls>
//   <｜｜DSML｜｜ invoke name="bash">
//   <｜｜DSML｜｜ parameter name="command" string="true">free -h</｜｜DSML｜｜ parameter>
//   <｜｜DSML｜｜ invoke>
//   </｜｜DSML｜｜ calls>
// Markers use full-width pipes (｜, U+FF5C); ASCII pipes are accepted
// defensively. Closers are sloppy in the wild (`</｜｜DSML｜｜ calls>` but bare
// `<｜｜DSML｜｜ invoke>` / `<｜｜DSML｜｜ parameter>` with no slash), so a tag
// carrying `name="…"` opens a block and the next same-kind tag closes it.
// Like the XML-children/tag-suffix shapes, these double-pipe DSML blocks carry no
// JSON body with a `_nonce`, so the nonce check does not apply to them here
// (a call is only checked when it does carry `_nonce`, see finalizeBoundCalls).
// The single-pipe `|DSML|` and full-width fork dialects are different: those are
// nonce-bound and schema-validated in parseFullWidthDsmlCalls.
