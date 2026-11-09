// Extracted from index.ts — pattern-based pricing fallback.
export const PATTERN_PRICING = [
	// --- Codex variants ---
	{
		pattern: "*-codex-xhigh",
		pricing: { input: 10.0, output: 40.0, cached: 5.0, reasoning: 60.0, cache_creation: 10.0 },
	},
	{
		pattern: "*-codex-high",
		pricing: { input: 8.0, output: 32.0, cached: 4.0, reasoning: 48.0, cache_creation: 8.0 },
	},
	{
		pattern: "*-codex-max",
		pricing: { input: 8.0, output: 32.0, cached: 4.0, reasoning: 48.0, cache_creation: 8.0 },
	},
	{
		pattern: "*-codex-mini-*",
		pricing: { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 },
	},
	{
		pattern: "*-codex-mini",
		pricing: { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 },
	},
	{
		pattern: "*-codex-low",
		pricing: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
	},
	{
		pattern: "*-codex-none",
		pricing: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
	},
	{
		pattern: "*-codex-spark",
		pricing: { input: 3.0, output: 12.0, cached: 0.3, reasoning: 12.0, cache_creation: 3.0 },
	},
	{
		pattern: "codex-*",
		pricing: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
	},
	{
		pattern: "*-codex",
		pricing: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
	},

	// --- Claude ---
	{
		pattern: "claude-opus-*",
		pricing: { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
	},
	{
		pattern: "claude-sonnet-*",
		pricing: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
	},
	{
		pattern: "claude-haiku-*",
		pricing: { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 },
	},
	{
		pattern: "claude-*",
		pricing: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
	},

	// --- Gemini (specific first, generic last) ---
	{
		pattern: "gemini-*-flash-lite",
		pricing: { input: 0.15, output: 1.25, cached: 0.015, reasoning: 1.875, cache_creation: 0.15 },
	},
	{
		pattern: "gemini-*-flash",
		pricing: { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75, cache_creation: 0.3 },
	},
	{
		pattern: "gemini-*-pro",
		pricing: { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 },
	},
	{
		pattern: "gemini-3-*",
		pricing: { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 },
	},
	{
		pattern: "gemini-2.5-*",
		pricing: { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75, cache_creation: 0.3 },
	},
	{
		pattern: "gemini-*",
		pricing: { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 },
	},

	// --- GPT (specific first, generic last) ---
	{
		pattern: "gpt-5.6-*",
		pricing: { input: 2.5, output: 15.0, cached: 0.25, reasoning: 15.0, cache_creation: 2.5 },
	},
	{
		pattern: "gpt-5.3-*",
		pricing: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
	},
	{
		pattern: "gpt-5.2-*",
		pricing: { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
	},
	{
		pattern: "gpt-5.1-*",
		pricing: { input: 1.25, output: 10.0, cached: 0.625, reasoning: 10.0, cache_creation: 1.25 },
	},
	{
		pattern: "gpt-5-*",
		pricing: { input: 1.25, output: 10.0, cached: 0.625, reasoning: 10.0, cache_creation: 1.25 },
	},
	{
		pattern: "gpt-5*",
		pricing: { input: 1.25, output: 10.0, cached: 0.625, reasoning: 10.0, cache_creation: 1.25 },
	},
	{
		pattern: "gpt-4o-*",
		pricing: { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.9, cache_creation: 0.15 },
	},
	{
		pattern: "gpt-4o",
		pricing: { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
	},
	{
		pattern: "gpt-4*",
		pricing: { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
	},

	// --- o1 / o-series ---
	{
		pattern: "o1-*",
		pricing: { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 },
	},
	{
		pattern: "o1",
		pricing: { input: 15.0, output: 60.0, cached: 7.5, reasoning: 90.0, cache_creation: 15.0 },
	},
	{
		pattern: "o3-*",
		pricing: { input: 10.0, output: 40.0, cached: 5.0, reasoning: 60.0, cache_creation: 10.0 },
	},
	{
		pattern: "o4-*",
		pricing: { input: 2.0, output: 8.0, cached: 1.0, reasoning: 12.0, cache_creation: 2.0 },
	},

	// --- Qwen ---
	{
		pattern: "qwen3-coder-*",
		pricing: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	},
	{
		pattern: "qwen*-coder-*",
		pricing: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	},
	{
		pattern: "qwen*",
		pricing: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	},

	// --- Kimi ---
	{
		pattern: "kimi-*-thinking",
		pricing: { input: 1.8, output: 7.2, cached: 0.9, reasoning: 10.8, cache_creation: 1.8 },
	},
	{
		pattern: "kimi-k3*",
		pricing: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.0 },
	},
	{
		pattern: "kimi-k2*",
		pricing: { input: 1.2, output: 4.8, cached: 0.6, reasoning: 7.2, cache_creation: 1.2 },
	},
	{
		pattern: "kimi-*",
		pricing: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	},

	// --- DeepSeek ---
	{
		pattern: "deepseek-*reasoner*",
		pricing: { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28, cache_creation: 0.14 },
	},
	{
		pattern: "deepseek-r*",
		pricing: { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28, cache_creation: 0.14 },
	},
	{
		pattern: "deepseek-v*",
		pricing: { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28, cache_creation: 0.14 },
	},
	{
		pattern: "deepseek-*",
		pricing: { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28, cache_creation: 0.14 },
	},

	// --- GLM ---
	{
		pattern: "glm-5*",
		pricing: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	},
	{
		pattern: "glm-4*",
		pricing: { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
	},
	{
		pattern: "glm-*",
		pricing: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	},

	// --- MiniMax ---
	{
		pattern: "MiniMax-*",
		pricing: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	},
	{
		pattern: "minimax-*",
		pricing: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	},

	// --- Grok ---
	{
		pattern: "grok-code-*",
		pricing: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	},
	{
		pattern: "grok-*",
		pricing: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	},
]
