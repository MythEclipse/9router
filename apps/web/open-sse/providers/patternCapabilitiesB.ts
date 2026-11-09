// Extracted from capabilities.ts — PATTERN_CAPABILITIES chunk 2/2. Merged back in capabilities.ts; do not import directly.
import { GLM_ZAI, KIMI_LOCKED } from "./patternCapabilityBases.ts"

export const PATTERN_CAPABILITIES_B = [
	{
		pattern: "*qwen*235b*",
		caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 },
	},
	{
		pattern: "*qwq*",
		caps: {
			reasoning: true,
			thinkingFormat: "qwen",
			thinkingCanDisable: false,
			contextWindow: 131072,
		},
	},
	{ pattern: "*qwen*", caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

	// ── Kimi (enabled→reasoning_effort; K2.7-code cannot disable) ─────
	{ pattern: "*kimi*k3*", caps: { ...KIMI_LOCKED, contextWindow: 1048576, maxOutput: 131072 } },
	{
		pattern: "*kimi*for-coding*",
		caps: { ...KIMI_LOCKED, contextWindow: 262144, maxOutput: 65536 },
	},
	{ pattern: "*kimi*k2.7*code*", caps: { ...KIMI_LOCKED, contextWindow: 262144, maxOutput: 65536 } },
	{
		pattern: "*kimi*k2*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "kimi",
			contextWindow: 262144,
			maxOutput: 262144,
		},
	},
	{ pattern: "*kimi*", caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

	// ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
	// reasoning_effort is only read by z.ai from GLM-5.2 onward (docs.z.ai/guides/capabilities/thinking) —
	// older GLM (4.x, 5.0, 5.1, 5-turbo, 5v-turbo) ignore it, so gate it per exact version, not the "*glm-5*" catch-all.
	// thinkingCanDisable:false for the whole 5.3 line, per z.ai docs:
	// "GLM-5.3 and GLM-5.3-FLASH no longer support disabling thinking (an error
	// will occur if the thinking.type parameter is set to disabled)." Set on the
	// pattern rather than an exact entry so both glm-5.3 and glm-5.3-flash get it
	// while keeping thinkingEffortSupported:true, which the pattern owns. #4409
	{
		pattern: "*glm-5.3*",
		caps: {
			reasoning: true,
			thinkingFormat: "zai",
			thinkingEffortSupported: true,
			thinkingCanDisable: false,
			contextWindow: 1000000,
			maxOutput: 128000,
		},
	},
	// 5.2 keeps its 1M window. thinkingCanDisable is deliberately NOT set here:
	// the exact MODEL_CAPABILITIES entry for glm-5.2 (added Sep 2026) already
	// declares it false, and that predates this fix — z.ai's docs suggest 5.2 can
	// in fact disable thinking, so that entry looks wrong, but changing it is
	// outside the scope of #4409 and is worth its own issue.
	{
		pattern: "*glm-5.2*",
		caps: {
			reasoning: true,
			thinkingFormat: "zai",
			thinkingEffortSupported: true,
			contextWindow: 1000000,
			maxOutput: 128000,
		},
	},
	{ pattern: "*glm-5*", caps: GLM_ZAI },
	{ pattern: "*glm-4.7*", caps: GLM_ZAI },
	{ pattern: "*glm-4*", caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
	{ pattern: "*glm*", caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

	// ── DeepSeek (thinking.enabled + reasoning_effort; r1 = thinking-only) ─
	// v4.1+ has real image input (probed live on Alibaba MaaS: correct color
	// read from a PNG). v4-pro / v4-flash-0731 accept image blocks but ignore
	// them (answered "Unknown"), so vision stays scoped to v4.* dotted releases.
	{
		pattern: "*deepseek-v4.*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingEffortSupported: true,
			contextWindow: 1000000,
			maxOutput: 128000,
		},
	},
	{
		pattern: "*deepseek-v4*",
		caps: {
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingEffortSupported: true,
			contextWindow: 1000000,
			maxOutput: 384000,
		},
	},
	{
		pattern: "*reasoner*",
		caps: {
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingCanDisable: false,
			contextWindow: 128000,
		},
	},
	{
		pattern: "*deepseek-r*",
		caps: {
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingCanDisable: false,
			contextWindow: 128000,
		},
	},
	{ pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
	{
		pattern: "*deepseek*",
		caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 },
	},

	// ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
	{ pattern: "*minimax*image*", caps: { imageOutput: true } },
	{
		pattern: "*minimax-m3*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "minimax",
			contextWindow: 1000000,
			maxOutput: 131072,
		},
	},
	{
		pattern: "*minimax-m2.7*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "minimax",
			thinkingCanDisable: false,
			contextWindow: 204800,
			maxOutput: 131072,
		},
	},
	{
		pattern: "*minimax-m2.5*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "minimax",
			thinkingCanDisable: false,
			contextWindow: 204800,
			maxOutput: 131072,
		},
	},
	{
		pattern: "*minimax*",
		caps: {
			reasoning: true,
			thinkingFormat: "minimax",
			thinkingCanDisable: false,
			contextWindow: 200000,
			maxOutput: 131072,
		},
	},

	// ── Xiaomi MiMo (vision + <think>-tag reasoning, always-on, can't disable) ──
	{
		pattern: "*mimo*v2.6*",
		caps: {
			vision: true,
			audioInput: true,
			videoInput: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 1048576,
			maxOutput: 131072,
		},
	},
	{
		pattern: "*mimo*v2.5*",
		caps: {
			vision: true,
			audioInput: true,
			videoInput: true,
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingCanDisable: false,
			contextWindow: 1048576,
			maxOutput: 131072,
		},
	},
	{
		pattern: "*mimo*omni*",
		caps: {
			vision: true,
			audioInput: true,
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingCanDisable: false,
			contextWindow: 262144,
			maxOutput: 131072,
		},
	},
	{
		pattern: "*mimo*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "deepseek",
			thinkingCanDisable: false,
			contextWindow: 262144,
			maxOutput: 131072,
		},
	},

	// ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
	{ pattern: "*llama-4*", caps: { vision: true, contextWindow: 1000000 } },
	{ pattern: "*llama*", caps: { contextWindow: 128000 } },

	// ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
	{ pattern: "*codestral*", caps: { contextWindow: 256000 } },
	{ pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
	{ pattern: "*mistral*", caps: { contextWindow: 128000 } },

	// ── Cohere (Command A Vision = vision; others text) ──────────────
	{ pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
	{ pattern: "*command*", caps: { contextWindow: 128000 } },

	// ── Perplexity (web search native) ───────────────────────────────
	{ pattern: "*sonar*", caps: { search: true, contextWindow: 128000 } },
	{ pattern: "*pplx*", caps: { search: true, contextWindow: 128000 } },
	{ pattern: "*perplexity*", caps: { search: true, contextWindow: 128000 } },

	// ── Poolside Laguna (resellers: openrouter/nvidia/kilocode/vercel/...) ──
	// Free tiers cap S 2.1 well below the paid 1M window → match the free suffix
	// (":free" or "-free", depending on reseller) before the plain id.
	{
		pattern: "*laguna-s-2.1*free*",
		caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },
	},
	{
		pattern: "*laguna-s-2.1*",
		caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 },
	},
	{
		pattern: "*laguna*",
		caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },
	},

	// ── OpenCode Free Muse Spark (multimodal text+image; OpenAI Responses reasoning supports up to xhigh) ─
	{
		pattern: "*muse*spark*",
		caps: {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 1048576,
			maxOutput: 131072,
		},
	},
	// ── Others ───────────────────────────────────────────────────────
	{
		pattern: "*hunyuan*",
		caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 },
	},
	{
		pattern: "hy3*",
		caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 },
	},
	{ pattern: "*step-*", caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
	{ pattern: "*nemotron*", caps: { reasoning: true, contextWindow: 128000 } },
	{ pattern: "*ling-*", caps: { reasoning: true, contextWindow: 128000 } },
]
