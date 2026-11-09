import { getAttr } from "./deepseekXmlTags.ts"
export const DSML_PIPE = "[｜|]"
export const DSML_MARK = `${DSML_PIPE}{2}DSML${DSML_PIPE}{2}`

// Matches one DSML tag of the given logical kind (calls|invoke|parameter),
// tolerating the slash before `<`, after the mark, or missing entirely.
// Group 1 captures the raw attribute text when the tag carries any.
export function dsmlTagSource(kind) {
	return `(?:<\\s*/?\\s*${DSML_MARK}\\s*${kind}\\b([^>]*)>|<${DSML_MARK}\\s*/\\s*${kind}\\s*>)`
}

// A closer cut off before its `>` (`</｜｜DSML｜｜ invoke`, the stream stopped mid-tag) is still a
// tag boundary the parser has to see: without it the open before it pairs with the NEXT open,
// which is how a truncated reply swallowed the following call and handed back markup as prose.
export const DSML_CUT_TAG_RE = new RegExp(`</?${DSML_MARK}\\s*(?:calls|invoke|parameter)\\b`, "i")

export function hasDsmlTags(text) {
	return DSML_CUT_TAG_RE.test(text)
}

// Any single DSML tag (open/close, sloppy or strict). Used to scrub DSML
// noise out of `<tool>` blocks for the hybrid shape the model occasionally
// emits: `<tool>{json}</｜｜DSML｜｜ parameter>…` (JSON body with a valid
// nonce, but DSML closers instead of `</tool>`).
export const DSML_ANY_TAG_RE = new RegExp(
	`</?${DSML_MARK}\\s*(?:calls|invoke|parameter)\\b[^>]*>|<${DSML_MARK}\\s*/\\s*(?:calls|invoke|parameter)\\s*>`,
	"gi",
)

// Extract DSML calls in document order. Reuses the shared getAttr /
// resolveRequestedToolName helpers so name resolution behaves exactly like the
// `<tool>` shapes (including the unknown-tool fallthrough).
//
// Two invocation sites share one builder: `<invoke>` blocks inside a
// `<calls>` envelope, and bare root-level `<invoke>` blocks with no envelope
// (same conversion either way). Fail-safe rule: an invoke that yields no
// parameter with a non-empty value produces NO call — an empty, nameless or
// otherwise ambiguous invoke is skipped instead of emitting a partially-built
// executable call.
export function collectDsmlTags(source, kind, base) {
	const out = []
	const re = new RegExp(dsmlTagSource(kind), "gi")
	let m = null
	while ((m = re.exec(source)) !== null) {
		const attrs = m[1] ?? ""
		out.push({
			start: base + m.index,
			end: base + re.lastIndex,
			attrs,
			// A tag carrying a name opens a block, unless it is written as a closer (`</… invoke>`):
			// that is the stray closer a truncated reply can leave at its head, and pairing it with
			// the next open would swallow the call under it. A nameless tag closes the block before.
			opening: getAttr(attrs, "name") !== null && !/^<\s*\//.test(m[0]),
		})
	}
	return out
}

/**
 * Pair each opening DSML tag with the next tag of its kind, as the sloppy dialect is read:
 * the closer is the next same-kind tag, whatever it is spelled. Returns `[open, close]` pairs
 * in document order, `close` undefined when the block never closed (reply truncated) — those
 * are still parsed, so a call the model declared right before the cut is not lost with it.
 */
export function pairDsmlTags(tags) {
	const pairs = []
	for (let i = 0; i < tags.length; i += 1) {
		if (!tags[i].opening) continue
		pairs.push([tags[i], tags[i + 1]])
		if (tags[i + 1]) i += 1 // consume the paired closer
	}
	return pairs
}

/** Where a block that never closed should be considered to end. */
export function dsmlBlockEnd(open, close, text) {
	if (close) return { innerEnd: close.start, stripEnd: close.end }
	// Truncated: the block runs to the next tag of its OWN kind — another invoke, or the envelope's
	// closer; its own parameters are inside it. So neither a later call nor the legitimate prose
	// after this one is swallowed into its last parameter value.
	const tagRe = new RegExp(`<\\s*/?\\s*${DSML_MARK}\\s*(?:calls|invoke)\\b[^>]*>`, "gi")
	tagRe.lastIndex = open.end
	let end = text.length
	let m = null
	while ((m = tagRe.exec(text)) !== null) {
		end = m.index
		break
	}
	return { innerEnd: end, stripEnd: end }
}

// A truncated stream can cut a tag off before its `>` — most often in the middle of the attribute
// list (`<｜｜DSML｜｜ parameter name="command" string="`). Such a tag still opens a block; it only
// never closes. The other way a tag goes wrong is running straight on into its value
// (`string="true"ls`), where the `>` never arrived at all.
//
// The attribute list is scanned by hand rather than by one composed regex: whether a tag has
// ended depends on the quote state left by what came before it, and a regex built out of those
// alternatives reads that state wrong (a quoted value and a bare word do not share a charset).

/** Index just past the `>` that ends the tag opened at `start`, or -1 when the stream cut it. */
export function scanTagEnd(source, start) {
	let quote = null
	for (let i = start; i < source.length; i += 1) {
		const ch = source[i]
		if (ch === "\\") {
			i += 1 // an escaped character never closes the value it is in
			continue
		}
		if (quote) {
			if (ch === quote) quote = null
			continue
		}
		if (ch === '"' || ch === "'") quote = ch
		else if (ch === ">") return i + 1
		else if (ch === "<") return -1 // the next tag began before this one closed
	}
	return -1
}

/**
 * Where a `>` belongs in the attribute list of a tag the stream cut, relative to `start`, or null
 * when the tag stopped between attributes and opens nothing. Two cuts lose it:
 *   `name="command" string="`   inside the value -> the value is empty, the tag ends where it stopped
 *   `string="true"ls`           value ran on    -> `string="true"`, then the value `ls`
 * Only a CLOSING quote can be followed by a value that ran on; an opening one is always followed
 * by its own value.
 */
export function closeAttrList(rest) {
	const lineEnd = rest.search(/[\n<]/)
	const attrs = lineEnd === -1 ? rest : rest.slice(0, lineEnd)
	let quote = null
	let close = null
	for (let i = 0; i < attrs.length; i += 1) {
		const ch = attrs[i]
		if (ch === "\\") {
			i += 1
		} else if (quote) {
			if (ch !== quote) continue
			quote = null
			close = i + 1
			if (/\S/.test(attrs[i + 1] ?? "") && !/[=>]/.test(attrs[i + 1]))
				return { end: i + 1, ranOn: true }
		} else if (ch === '"' || ch === "'") {
			quote = ch
		}
	}
	// The value of a parameter is its body, so a tag cut inside it has ended; a tag cut between
	// attributes (`string=`) ended on the attribute before, and opens nothing either way.
	return close === null ? null : { end: attrs.length, ranOn: false }
}

/** Put back the separator the cut removed, so the shared attribute reader sees each attribute. */
export function repairDsmlAttrs(attrs) {
	// A quoted value whose closing quote runs straight into the next attribute (`string="true"ls`
	// is `string="true" ls`): scan the quote pairs so only the CLOSING quote counts, never the one
	// that opened the value. A function replacement, since a string one would read `$1` as a
	// backreference and lose the quote.
	let out = ""
	let quote = null
	for (let i = 0; i < attrs.length; i += 1) {
		const ch = attrs[i]
		out += ch
		if (ch === "\\") {
			out += attrs[i + 1] ?? ""
			i += 1
		} else if (quote) {
			if (ch !== quote) continue
			quote = null
			if (!/[\s=/>]/.test(attrs[i + 1] ?? "")) out += " "
		} else if (ch === '"' || ch === "'") {
			quote = ch
		}
	}
	return out.replace(/\s+/g, " ").trim()
}

const DSML_OPEN_RE = new RegExp(`<${DSML_MARK}\\s*(calls|invoke|parameter)\\b`, "gi")

/**
 * The text with every DSML tag closed where the stream cut it. A tag whose value ran on into it gets
 * the back the separator the cut took; the tag simply gets back its `>`. Both let the dialects below
 * see the block it opened instead of the markup. Null when nothing needed repair.
 */
export function rewriteCutDsmlTags(text) {
	const out = []
	const mark = /^<[｜|]{1,2}DSML[｜|]{1,2}/i
	DSML_OPEN_RE.lastIndex = 0
	let m = DSML_OPEN_RE.exec(text)
	while (m !== null) {
		const attrsStart = m.index + m[0].length
		// A tag that closed where the dialect below already reads it needs no repair.
		const closed = scanTagEnd(text, attrsStart) !== -1
		const cut = closed ? null : closeAttrList(text.slice(attrsStart))
		if (!cut) {
			DSML_OPEN_RE.lastIndex = attrsStart
			m = DSML_OPEN_RE.exec(text)
			continue
		}
		const stop = attrsStart + cut.end
		const attrs = repairDsmlAttrs(text.slice(attrsStart, stop))
		// The mark travels with the tag: `parseDsmlBlocks` reads its parameters by their DSML
		// spelling, and a bare `<parameter>` is not a tag it can see.
		const head = `${text.slice(m.index).match(mark)?.[0] ?? ""} ${m[1].toLowerCase()}${attrs ? ` ${attrs}` : ""}`
		out.push({ start: m.index, end: stop, text: `${head}>` })
		DSML_OPEN_RE.lastIndex = stop
		m = DSML_OPEN_RE.exec(text)
	}
	return out
}

/** The reply with each cut tag closed, and where the `>` it never sent now sits. */
export function applyCutRepair(text, repairs) {
	let out = ""
	let cursor = 0
	let shift = 0
	const inserted = []
	for (const repair of repairs) {
		out += text.slice(cursor, repair.start)
		out += repair.text
		// Offsets after the splice: each repair moved everything behind it by exactly its own growth.
		inserted.push(repair.start + shift + repair.text.length - 1)
		shift += repair.text.length - (repair.end - repair.start)
		cursor = repair.end
	}
	return { text: out + text.slice(cursor), inserted }
}
