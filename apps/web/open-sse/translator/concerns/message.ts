import { OPENAI_BLOCK } from "../schema/index.ts"

// Collapse an OpenAI content-part array: a lone text part becomes a plain string,
// otherwise the array is returned as-is. Matches existing translator behavior.
// Cache-aware targets (opts.preserveCacheControl) retain a marked block as-is so
// its cache_control boundary survives the flattening.
export function collapseTextParts(parts, opts: { preserveCacheControl?: boolean } = {}) {
	return parts.length === 1 &&
		parts[0].type === OPENAI_BLOCK.TEXT &&
		!(opts.preserveCacheControl && parts[0].cache_control)
		? parts[0].text
		: parts
}
