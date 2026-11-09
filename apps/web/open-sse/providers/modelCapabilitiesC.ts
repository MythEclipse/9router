// Extracted from capabilities.ts — MODEL_CAPABILITIES chunk 3/3. Merged back in capabilities.ts; do not import directly.
export const MODEL_CAPABILITIES_C = {
	"glm-4.5v": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "zai",
		contextWindow: 64000,
		maxOutput: 16384,
	},
	// GLM-5.2 has 1M context — pattern *glm-5* only gives 200k, so override here.
	// thinkingEffortSupported must be repeated: an exact entry short-circuits the
	// pattern table (see resolveCaps order), so omitting it here silently drops the
	// flag that the *glm-5.2* pattern sets.
	"glm-5.2": {
		reasoning: true,
		thinkingFormat: "zai",
		thinkingEffortSupported: true,
		thinkingCanDisable: false,
		contextWindow: 1000000,
		maxOutput: 131072,
	},
	// OpenCode serves the same weights under this free id from its OWN inference
	// service, which validates the body strictly: the zai `thinking` object the
	// *glm-5.3* pattern emits is answered
	//   400 [unknown_parameter] invalid request body: json: unknown field "thinking"
	// while reasoning_effort is accepted (none/minimal/low/medium/high/xhigh/max → 200).
	// Probed live 2026-10-18 on both lanes exposing the id: /inference/v1 (provider
	// "opencode") and /zen/v1 (provider "opencode-zen"). Mirrors the
	// PROVIDER_CAPABILITIES["opencode-go"] override for the paid glm-5.3-flash id;
	// the zai shape stays correct for z.ai's own lines (glm / glm-cn). codebuddy-cn
	// is unaffected — it already resolves glm-5.3-flash to the openai shape.
	// Known gap, shared with the paid sibling: an intent that carries no level
	// (Claude adaptive thinking, reasoning_effort "auto") still emits literal
	// "auto" from the generic openai branch, which this service rejects.
	"glm-5.3-flash-free": {
		vision: true,
		videoInput: true,
		pdf: true,
		reasoning: true,
		thinkingFormat: "openai",
		thinkingCanDisable: false,
		contextWindow: 1000000,
		maxOutput: 128000,
	},

	// DeepSeek's first V4 model with image input; text limits match V4-Flash.
	"deepseek-v4-flash-vision-exp": {
		vision: true,
		reasoning: true,
		thinkingFormat: "deepseek",
		contextWindow: 1000000,
		maxOutput: 384000,
	},

	// DeepSeek V4.1-Flash is natively multimodal — models.dev lists
	// opencode-go/deepseek-v4.1-flash with modalities.input ["text","image"] — and upstream
	// the retired v4-flash / vision-exp ids route to it, so the live V4.1 ids carry the
	// same image capability as the exp id above. "deepseek-flash" is the GA id on the
	// DeepSeek API; it previously fell through to the generic *deepseek* pattern, whose
	// 128K/64K limits are kept here. The repeated fields are deliberate: an exact entry
	// short-circuits the pattern table, so a vision-only delta would drop them.
	// Some providers (e.g. Kenari) expose this model under the hyphenated ID
	// "deepseek-v4-1-flash" (dash instead of dot); add it as an alias (#4293).
	"deepseek-v4.1-flash": {
		vision: true,
		reasoning: true,
		thinkingFormat: "deepseek",
		contextWindow: 1000000,
		maxOutput: 384000,
	},
	"deepseek-v4-1-flash": {
		vision: true,
		reasoning: true,
		thinkingFormat: "deepseek",
		contextWindow: 1000000,
		maxOutput: 384000,
	},
	"deepseek-flash": {
		vision: true,
		reasoning: true,
		thinkingFormat: "deepseek",
		contextWindow: 128000,
		maxOutput: 64000,
	},

	// Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
	"vision-model": { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
	"coder-model": { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },

	// Kimi flagship + coding (platform + Kimi Code ids) — vision/video native
	"kimi-k3": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 1048576,
		maxOutput: 131072,
	},
	k3: {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 1048576,
		maxOutput: 131072,
	},
	"kimi-k3.1-pro": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 1048576,
		maxOutput: 131072,
	},
	"kimi-for-coding": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 262144,
		maxOutput: 65536,
	},
	"kimi-for-coding-highspeed": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 262144,
		maxOutput: 65536,
	},
	"kimi-k2.7-code": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 262144,
		maxOutput: 65536,
	},
	"kimi-k2.7-code-highspeed": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "kimi",
		thinkingCanDisable: false,
		contextWindow: 262144,
		maxOutput: 65536,
	},
	// OpenCode Free Muse Spark — multimodal (text+image per models.dev meta/muse-spark)
	// via OpenAI Responses input_image; reasoning supports up to xhigh.
	// OpenCode Free Union Alpha — multimodal (text+vision), 262K context, 131K max output
	"union-alpha": { vision: true, contextWindow: 262144, maxOutput: 131072 },
	// ── OpenCode Free (reasoning: true in models.dev, ids newer than the tables above) ──
	// Without these entries getCapabilitiesForModel() falls through to
	// DEFAULT_CAPABILITIES (reasoning: false) and applyThinking() strips the client's
	// reasoning_effort before it reaches the upstream — see #2690.
	// Modalities and limits below are taken verbatim from models.dev.
	"space-bunny-free": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1048576,
		maxOutput: 524288,
	},
	"space-bunny": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1048576,
		maxOutput: 524288,
	},
	"big-pickle": {
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 200000,
		maxOutput: 32000,
	},
	"exo-free": {
		vision: true,
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1048576,
		maxOutput: 131072,
	},
	"fledge-alpha-free": {
		vision: true,
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1048576,
		maxOutput: 131072,
	},
	"longcat-2.0": {
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1000000,
		maxOutput: 131072,
	},
	"longcat-2.0-free": {
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1000000,
		maxOutput: 131072,
	},
	"longcat-2.5-preview-free": {
		vision: true,
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1000000,
		maxOutput: 131072,
	},
	"north-mini-code-free": {
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 256000,
		maxOutput: 64000,
	},
	"ring-2.6-1t-free": {
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 262000,
		maxOutput: 66000,
	},
	"x-preview-f-free": {
		vision: true,
		videoInput: true,
		reasoning: true,
		thinkingFormat: "openai",
		contextWindow: 1000000,
		maxOutput: 131072,
	},
}
