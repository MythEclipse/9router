// Extracted from capabilities.ts — shared capability bases for PATTERN_CAPABILITIES families.
/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
/**
 * Capability bases shared by every pattern in a family.
 *
 * Each family repeats the same feature set across a dozen version patterns that differ
 * only in context window or thinking format. Writing the base once and naming the
 * family makes a feature fix one edit instead of twelve, and keeps a version that
 * genuinely differs visibly different.
 */
export const CLAUDE_ADAPTIVE = {
	vision: true,
	pdf: true,
	reasoning: true,
	search: true,
	thinkingFormat: "claude-adaptive",
}
export const CLAUDE_BUDGET = {
	vision: true,
	pdf: true,
	reasoning: true,
	search: true,
	thinkingFormat: "claude-budget",
}
export const CLAUDE_LONG_1M = { contextWindow: 1000000, maxOutput: 128000 }
export const GEMINI_LEVEL = {
	vision: true,
	audioInput: true,
	videoInput: true,
	reasoning: true,
	search: true,
	thinkingFormat: "gemini-level",
	thinkingCanDisable: false,
	contextWindow: 1048576,
}
export const GEMINI_FLAT = {
	vision: true,
	audioInput: true,
	videoInput: true,
	search: true,
	contextWindow: 1048576,
}
export const GPT5_FULL = {
	vision: true,
	reasoning: true,
	search: true,
	thinkingFormat: "openai",
	contextWindow: 400000,
	maxOutput: 128000,
}
export const GPT5_LONG_1M = { ...GPT5_FULL, contextWindow: 1050000 }
export const QWEN37 = {
	vision: true,
	videoInput: true,
	reasoning: true,
	thinkingFormat: "qwen",
	contextWindow: 1000000,
	maxOutput: 65536,
}
export const KIMI_LOCKED = {
	vision: true,
	videoInput: true,
	reasoning: true,
	thinkingFormat: "kimi",
	thinkingCanDisable: false,
}
export const GLM_ZAI = {
	reasoning: true,
	thinkingFormat: "zai",
	contextWindow: 200000,
	maxOutput: 128000,
}
