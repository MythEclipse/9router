// Extracted from capabilities.ts — PATTERN_CAPABILITIES chunk 1/2. Merged back in capabilities.ts; do not import directly.
import {
	CLAUDE_ADAPTIVE,
	CLAUDE_BUDGET,
	CLAUDE_LONG_1M,
	GEMINI_FLAT,
	GEMINI_LEVEL,
	GPT5_FULL,
	GPT5_LONG_1M,
	QWEN37,
} from "./patternCapabilityBases.ts"

export const PATTERN_CAPABILITIES_A = [
	// ── Claude (4.6+ = adaptive thinking; older/haiku = budget) ──────
	{ pattern: "*claude*opus-5*", caps: { ...CLAUDE_ADAPTIVE, ...CLAUDE_LONG_1M } },
	{ pattern: "*claude*sonnet-5*", caps: { ...CLAUDE_ADAPTIVE, ...CLAUDE_LONG_1M } },
	{ pattern: "*claude*opus-4.6*", caps: CLAUDE_ADAPTIVE },
	{ pattern: "*claude*opus-4.7*", caps: CLAUDE_ADAPTIVE },
	{ pattern: "*claude*opus-4.8*", caps: CLAUDE_ADAPTIVE },
	{ pattern: "*claude*sonnet-4.6*", caps: CLAUDE_ADAPTIVE },
	{ pattern: "*claude*sonnet-4.7*", caps: CLAUDE_ADAPTIVE },
	// PDF input is supported by current Claude families. Keep legacy/generic
	// fallbacks conservative instead of inferring PDF support from vision alone.
	// https://platform.claude.com/docs/en/build-with-claude/pdf-support
	{ pattern: "*claude*haiku-5*", caps: CLAUDE_BUDGET },
	{ pattern: "*claude*haiku-4*", caps: CLAUDE_BUDGET },
	{ pattern: "*claude*opus-4*", caps: CLAUDE_BUDGET },
	{ pattern: "*claude*sonnet-4*", caps: CLAUDE_BUDGET },
	{
		pattern: "*claude*haiku*",
		caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" },
	},
	{
		pattern: "*claude*opus*",
		caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" },
	},
	{
		pattern: "*claude*sonnet*",
		caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" },
	},
	{ pattern: "*claude*fable*", caps: { ...CLAUDE_BUDGET, ...CLAUDE_LONG_1M } },
	{ pattern: "*claude*mythos*", caps: { ...CLAUDE_BUDGET, ...CLAUDE_LONG_1M } },
	{ pattern: "*claude-3*", caps: { vision: true } },
	{
		pattern: "*claude*",
		caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" },
	},

	// ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
	{ pattern: "*gemini*image*", caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
	// Gemini 4 (Argon): no "minimal" tier (400) and no thinkingBudget — LOW/MEDIUM/HIGH only, cannot disable.
	{ pattern: "*gemini-4*", caps: { ...GEMINI_LEVEL, maxOutput: 65536 } },
	{ pattern: "*gemini-3.8*", caps: { ...GEMINI_LEVEL, maxOutput: 65536 } },
	{ pattern: "*gemini-3.7*", caps: { ...GEMINI_LEVEL, maxOutput: 65536 } },
	{ pattern: "*gemini-3*pro*", caps: { ...GEMINI_LEVEL, maxOutput: 65535 } },
	{ pattern: "*gemini-3*", caps: { ...GEMINI_LEVEL, maxOutput: 65536 } },
	{
		pattern: "*gemini-2.5*",
		caps: {
			vision: true,
			audioInput: true,
			videoInput: true,
			reasoning: true,
			search: true,
			thinkingFormat: "gemini-budget",
			thinkingRange: { min: 0, max: 24576 },
			contextWindow: 1048576,
			maxOutput: 65536,
		},
	},
	{ pattern: "*gemini-2*", caps: { ...GEMINI_FLAT, maxOutput: 65536 } },
	{ pattern: "*gemini*", caps: { vision: true, search: true, contextWindow: 1048576 } },
	{ pattern: "*gemma*", caps: { vision: true, contextWindow: 128000 } },
	{ pattern: "*nanobanana*", caps: { vision: true, imageOutput: true } },

	// ── OpenAI GPT-6.x (vision + thinking + web search) ──────────────
	// Image variants are output-only models, not GPT chat models. Keep this
	// before the generic family match because the first matching pattern wins.
	{ pattern: "*gpt-6*image*", caps: { imageOutput: true } },
	// 1.05M is the API window for the whole gpt-6 family (astra, luna, sol alike).
	// A gateway that truncates lower records its own number in
	// PROVIDER_CAPABILITIES, which wins over this pattern — Kiro at 272k, Codex
	// OAuth at 272k/372k (see CODEX_GPT_56_* above). This entry used to carry
	// Kiro's 272k, so every other provider's gpt-6 models inherited one gateway's
	// limit and were published at 3.9x under their real window.
	{
		pattern: "*gpt-6*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 1050000,
			maxOutput: 128000,
		},
	},

	// ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
	{ pattern: "*gpt-5*image*", caps: { imageOutput: true } },
	{
		pattern: "*gpt-5*codex*",
		caps: {
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 400000,
			maxOutput: 128000,
		},
	},
	// gpt-5.4 is where the 1.05M window starts, but the mini and nano tiers stayed
	// at 400k — first match wins, so those two have to be listed ahead of it.
	{ pattern: "*gpt-5.4-mini*", caps: GPT5_FULL },
	{ pattern: "*gpt-5.4-nano*", caps: GPT5_FULL },
	{ pattern: "*gpt-5.4*", caps: GPT5_LONG_1M },
	{ pattern: "*gpt-5.5*", caps: GPT5_LONG_1M },
	{ pattern: "*gpt-5.6*", caps: GPT5_LONG_1M },
	{ pattern: "*gpt-5*", caps: GPT5_FULL },
	{
		pattern: "*gpt-4o*",
		caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 },
	},
	{ pattern: "*gpt-4.1*", caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
	{ pattern: "*gpt-4-turbo*", caps: { vision: true, contextWindow: 128000 } },
	{ pattern: "*gpt-4*", caps: { contextWindow: 128000 } },
	{ pattern: "*gpt-3.5*", caps: { contextWindow: 16385, maxOutput: 4096 } },
	{
		pattern: "*gpt-oss*",
		caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 },
	},

	// ── OpenAI o-series (reasoning, vision) ──────────────────────────
	{
		pattern: "*o1-mini*",
		caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 },
	},
	{
		pattern: "*o1*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 200000,
			maxOutput: 100000,
		},
	},
	{
		pattern: "*o3*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 200000,
			maxOutput: 100000,
		},
	},
	{
		pattern: "*o4*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 200000,
			maxOutput: 100000,
		},
	},

	// ── Grok (vision + Live Search) ──────────────────────────────────
	{ pattern: "*grok*image*", caps: { imageOutput: true } },
	{
		pattern: "*grok-code*",
		caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 },
	},
	// Grok 4.7: 500k context, same envelope as 4.6. Without its own row it fell to the
	// `*grok-4*` catch-all (256k), and stripHistoryForContext() trims at 80% of that.
	{
		pattern: "*grok-4.7*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 500000,
			maxOutput: 500000,
		},
	},
	// Grok 4.6: 500k context, no text output limit (docs.x.ai/developers/grok-4-6)
	{
		pattern: "*grok-4.6*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 500000,
			maxOutput: 500000,
		},
	},
	// Grok 4.5 (Grok CLI / Grok Build): 500k context per cli-chat-proxy /v1/models
	{
		pattern: "*grok-4.5*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 500000,
			maxOutput: 64000,
		},
	},
	{
		pattern: "*grok-4*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 256000,
		},
	},
	{
		pattern: "*grok-3*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 131072,
		},
	},
	{
		pattern: "*grok*",
		caps: {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 256000,
		},
	},

	// ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
	{
		pattern: "*qwen*vl*",
		caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 },
	},
	{
		pattern: "*qwen*omni*",
		caps: {
			vision: true,
			audioInput: true,
			videoInput: true,
			reasoning: true,
			thinkingFormat: "qwen",
			contextWindow: 262144,
			maxOutput: 65536,
		},
	},
	{
		pattern: "*qwen*coder*",
		caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
	},
	{
		pattern: "*qwen*max*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "qwen",
			contextWindow: 1000000,
			maxOutput: 65536,
		},
	},
	{ pattern: "*qwen3.5*", caps: QWEN37 },
	{ pattern: "*qwen3.6*", caps: QWEN37 },
	{ pattern: "*qwen3.7*", caps: QWEN37 },
	{
		pattern: "*qwen*plus*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "qwen",
			contextWindow: 1000000,
			maxOutput: 65536,
		},
	},
]
