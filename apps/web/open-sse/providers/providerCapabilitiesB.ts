// Extracted from capabilities.ts — PROVIDER_CAPABILITIES chunk 2/2. Merged back in capabilities.ts; do not import directly.
export const PROVIDER_CAPABILITIES_B = {
	// CodeBuddy.cn — authoritative per-model metadata from the gateway's model
	// config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
	// supportsImages). Every model reasons via OpenAI-style reasoning_effort
	// (see registry thinkingFormat). For thinkingCanDisable use the server's
	// reasoning.canDisableThinking flag — see the note in the codebuddy-cn block
	// below; it is NOT the inverse of onlyReasoning.
	"codebuddy-cn": {
		"glm-5.2": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 1000000,
			maxOutput: 131072,
		},
		"glm-5.1": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 200000,
			maxOutput: 48000,
		},
		"glm-5.0": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
		// maxOutput 64000 per both the plugin-baked fallback and the live server
		// table (the old 38000 had no source and truncated output).
		"glm-4.7": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
		"minimax-m3": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 512000,
			maxOutput: 524288,
		},
		"kimi-k2.5": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 164000,
			maxOutput: 32000,
		},
		"hy3-preview": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 192000,
			maxOutput: 64000,
		},
		"deepseek-v4-flash": {
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 1000000,
			maxOutput: 50000,
		},
		"deepseek-v3-2-volc": {
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 96000,
			maxOutput: 32000,
		},
		// Per-model values mirror the server's product-config payload (the plugin
		// fetches it from copilot.tencent.com; the `models[]` entries carry
		// maxInputTokens/maxOutputTokens/supportsImages). contextWindow =
		// maxInputTokens, maxOutput = maxOutputTokens. Where the server and the
		// plugin-baked fallback disagree, the server table wins.
		// ⚠️ thinkingCanDisable maps to the server's reasoning.canDisableThinking —
		// it is NOT the inverse of onlyReasoning. onlyReasoning means "thinking is
		// on by default"; canDisableThinking means "it CAN be turned off". glm-5.3
		// and glm-5.3-flash are onlyReasoning:true BUT canDisableThinking:true, so
		// their thinking is switchable; the hy* models are forced always-on.
		hy3: {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 192000,
			maxOutput: 64000,
		},
		"hy4-preview": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 1000000,
			maxOutput: 64000,
		},
		"glm-5.3": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 1000000,
			maxOutput: 131072,
		},
		"glm-5.3-flash": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 1000000,
			maxOutput: 131072,
		},
		"kimi-k3-1": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 1000000,
			maxOutput: 1048576,
		},
		// contextWindow is the server's contextWindow.defaultLength (300000), NOT
		// maxInputTokens — k2.8 publishes supportedLengths [300000, 1000000] and the
		// gateway only gives 1M when the request opts in (this executor never does).
		// Using 1000000 here would let the capacity adapter budget history for a
		// window the model doesn't actually have.
		"kimi-k2.8-preview": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 300000,
			maxOutput: 131072,
		},
		"deepseek-v4-pro": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 1000000,
			maxOutput: 393216,
		},
		// deepseek-v4.1-flash replaced v4-flash on the server list. The 2026-09-30
		// snapshot raised maxOutput to 393216 (matching v4-pro) and changed the
		// published efforts from low/high/xhigh to low/high/max.
		"deepseek-v4.1-flash": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: true,
			contextWindow: 1000000,
			maxOutput: 393216,
		},
	},
	// Poolside Laguna — OpenAI-compatible, all reasoning-capable (32K max output).
	poolside: {
		"laguna-s-2.1": {
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 1000000,
			maxOutput: 32000,
		},
		"laguna-xs-2.1": {
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 200000,
			maxOutput: 32000,
		},
	},
	// Ollama Cloud — the generic *deepseek-v4* pattern misses the vision badge
	// the library page publishes for this model (text+image in, 1M context).
	// ponytail: thinkingFormat stays "deepseek" to preserve today's body shape;
	// Ollama's native toggle is the top-level `think` field (bool or
	// low/medium/high/max), which no format in thinkingUnified.js emits yet —
	// openai-to-ollama.js drops it. Wire a "think" format when thinking on
	// Ollama Cloud is actually needed.
	ollama: {
		"deepseek-v4.1-flash:cloud": {
			vision: true,
			reasoning: true,
			thinkingFormat: "deepseek",
			contextWindow: 1000000,
			maxOutput: 384000,
		},
	},
	// MiniMax Code (mcode) credits lane — Anthropic messages on mavis; thinking
	// is adaptive effort via output_config (claude-adaptive). Limits from
	// magpie's minimax plugin static catalog (live probes pending). M2.7 pair
	// always thinks and takes no effort knob in MiniMax Code itself.
	"minimax-code": {
		"MiniMax-M3.1-Flash-Preview": {
			vision: true,
			reasoning: true,
			thinkingFormat: "claude-adaptive",
			thinkingCanDisable: false,
			contextWindow: 512000,
			maxOutput: 128000,
		},
		"MiniMax-M3": {
			vision: true,
			reasoning: true,
			thinkingFormat: "claude-adaptive",
			contextWindow: 512000,
			maxOutput: 128000,
		},
		"MiniMax-M2.7": {
			reasoning: true,
			thinkingFormat: "claude-adaptive",
			thinkingCanDisable: false,
			contextWindow: 200000,
			maxOutput: 128000,
		},
		"MiniMax-M2.7-highspeed": {
			reasoning: true,
			thinkingFormat: "claude-adaptive",
			thinkingCanDisable: false,
			contextWindow: 200000,
			maxOutput: 128000,
		},
	},
	// Nous Research Portal free-tier models (probed live against https://inference-api.nousresearch.com/v1/models).
	nous: {
		"meituan/longcat-2.0:free": {
			tools: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 1048756,
			maxOutput: 262144,
		},
		"meituan/longcat-2.5-preview:free": {
			tools: true,
			vision: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 1048576,
			maxOutput: 131072,
		},
		"stepfun/step-5-preview:free": {
			tools: true,
			vision: true,
			videoInput: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 1000000,
			maxOutput: 64000,
		},
		"upstage/solar-mini4:free": {
			tools: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 524288,
			maxOutput: 131072,
		},
		"stepfun/step-3.7-flash:free": {
			tools: true,
			vision: true,
			videoInput: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 262144,
			maxOutput: 256000,
		},
		"poolside/laguna-s-2.1:free": {
			tools: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 262144,
			maxOutput: 131072,
		},
		"poolside/laguna-xs-2.1:free": {
			tools: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 262144,
			maxOutput: 32768,
		},
		"stealth/missingno": {
			tools: true,
			reasoning: true,
			thinkingFormat: "nous",
			contextWindow: 262144,
			maxOutput: 131072,
		},
	},
}
