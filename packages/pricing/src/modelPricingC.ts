// Extracted from index.ts — MODEL_PRICING chunk 3/3. Merged back in index.ts; do not import directly.
export const MODEL_PRICING_C = {
	"gemini-2.5-flash-lite": {
		input: 0.15,
		output: 1.25,
		cached: 0.015,
		reasoning: 1.875,
		cache_creation: 0.15,
	},

	// === Qwen ===
	"qwen3-coder-plus": { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	"qwen3-coder-flash": {
		input: 0.5,
		output: 2.0,
		cached: 0.25,
		reasoning: 3.0,
		cache_creation: 0.5,
	},

	// === Kimi ===
	// Official platform.kimi.ai: cache-hit / cache-miss / output per 1M tokens
	"kimi-k3": { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.0 },
	"kimi-k3.1-pro": { input: 2.0, output: 10.0, cached: 0.2, reasoning: 10.0, cache_creation: 2.0 },
	k3: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.0 },
	"kimi-k2.7-code": { input: 0.95, output: 4.0, cached: 0.19, reasoning: 4.0, cache_creation: 0.95 },
	"kimi-k2.7-code-highspeed": {
		input: 1.9,
		output: 8.0,
		cached: 0.38,
		reasoning: 8.0,
		cache_creation: 1.9,
	},
	"kimi-for-coding": {
		input: 0.95,
		output: 4.0,
		cached: 0.19,
		reasoning: 4.0,
		cache_creation: 0.95,
	},
	"kimi-for-coding-highspeed": {
		input: 1.9,
		output: 8.0,
		cached: 0.38,
		reasoning: 8.0,
		cache_creation: 1.9,
	},
	"kimi-k2": { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	"kimi-k2-thinking": { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 },
	"kimi-k2.5": { input: 1.2, output: 4.8, cached: 0.6, reasoning: 7.2, cache_creation: 1.2 },
	"kimi-k2.5-thinking": {
		input: 1.8,
		output: 7.2,
		cached: 0.9,
		reasoning: 10.8,
		cache_creation: 1.8,
	},
	"kimi-k2.6": { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	"kimi-latest": { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },

	// === DeepSeek ===
	"deepseek-chat": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-reasoner": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-r1": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-v3.2-chat": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-v3.2-reasoner": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-v4-flash": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-v4.1-flash": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-flash": {
		input: 0.14,
		output: 0.28,
		cached: 0.0028,
		reasoning: 0.28,
		cache_creation: 0.14,
	},
	"deepseek-v4-pro": {
		input: 0.435,
		output: 0.87,
		cached: 0.003625,
		reasoning: 0.87,
		cache_creation: 0.435,
	},

	// === GLM ===
	"glm-4.6": { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	"glm-4.6v": { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
	"glm-4.7": { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
	"glm-5": { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },

	// === MiniMax ===
	"MiniMax-M3": { input: 0.3, output: 1.2, cached: 0.06, reasoning: 1.8, cache_creation: 0.3 },
	"MiniMax-M2.1": { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	"MiniMax-M2.5": { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	"MiniMax-M2.7": { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	"minimax-m2.1": { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },
	"minimax-m2.5": { input: 0.6, output: 2.4, cached: 0.3, reasoning: 3.6, cache_creation: 0.6 },

	// === Grok ===
	"grok-code-fast-1": { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0, cache_creation: 0.5 },

	// === Muse (Meta Model API) ===
	// Rates from https://dev.meta.ai/docs/pricing-rate-limits (contributor tier:
	// cheaper, Meta may train on the data).
	"muse-spark-1.3": { input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25, cache_creation: 0 },
	"muse-spark-1.2": { input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25, cache_creation: 0 },
	"muse-spark-1.1": { input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25, cache_creation: 0 },
	"muse-spark-1.3-contributor": {
		input: 0.1,
		output: 0.2,
		cached: 0.002,
		reasoning: 0.2,
		cache_creation: 0,
	},
	"muse-spark-1.2-contributor": {
		input: 0.1,
		output: 0.2,
		cached: 0.002,
		reasoning: 0.2,
		cache_creation: 0,
	},

	// === OpenRouter fallback ===
	auto: { input: 2.0, output: 8.0, cached: 1.0, reasoning: 12.0, cache_creation: 2.0 },

	// === Misc ===
	"oswe-vscode-prime": { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0, cache_creation: 1.0 },
	"gpt-oss-120b-medium": {
		input: 0.5,
		output: 2.0,
		cached: 0.25,
		reasoning: 3.0,
		cache_creation: 0.5,
	},
	"vision-model": { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 },
	"coder-model": { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0, cache_creation: 1.5 },
}
