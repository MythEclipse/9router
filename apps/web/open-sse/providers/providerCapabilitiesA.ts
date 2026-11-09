// Extracted from capabilities.ts — PROVIDER_CAPABILITIES chunk 1/2 (+ shared GPT caps helpers). Merged back in capabilities.ts; do not import directly.
const KIRO_GPT_5_6_CAPABILITIES = {
	vision: true,
	reasoning: true,
	search: true,
	thinkingFormat: "openai",
	contextWindow: 272000,
	maxOutput: 128000,
}

// Codex OAuth (ChatGPT backend) — per-model context window reported by upstream
// (lower than OpenAI API's 1.05M). Sol differs from Terra/Luna. #2720
const CODEX_GPT_56_SOL_CAPS = {
	vision: true,
	reasoning: true,
	search: true,
	thinkingFormat: "openai",
	contextWindow: 372000,
	maxOutput: 128000,
}
const CODEX_GPT_56_DEFAULT_CAPS = {
	vision: true,
	reasoning: true,
	search: true,
	thinkingFormat: "openai",
	contextWindow: 272000,
	maxOutput: 128000,
}
const CODEX_EXTENDED_CAPS = { ...CODEX_GPT_56_DEFAULT_CAPS, contextWindow: 872000 }

// Devin CLI's registry declares a 200k context window for these GPT variants.
// Keep the GPT feature/output fields because provider overrides short-circuit
// the generic pattern rather than merging with it.
const DEVIN_CLI_GPT_CAPS = {
	vision: true,
	reasoning: true,
	search: true,
	thinkingFormat: "openai",
	contextWindow: 200000,
	maxOutput: 128000,
}

export const PROVIDER_CAPABILITIES_A = {
	// NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
	// Force openai reasoning_effort format for its reasoning models. #issue
	nvidia: {
		"minimaxai/minimax-m2.7": {
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 200000,
			maxOutput: 131072,
		},
		"minimaxai/minimax-m3": {
			vision: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 512000,
			maxOutput: 131072,
		},
		"z-ai/glm-5.2": {
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 200000,
			maxOutput: 128000,
		},
		"deepseek-ai/deepseek-v4-pro": {
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 1000000,
			maxOutput: 65536,
		},
		"deepseek-ai/deepseek-v4-flash": {
			reasoning: true,
			thinkingFormat: "openai",
			contextWindow: 1000000,
			maxOutput: 65536,
		},
	},
	// OpenCode Free rejects prompts above roughly 330k for this model even
	// though its models endpoint reports a 1M context window.
	opencode: {
		"deepseek-v4.1-flash-free": {
			vision: true,
			reasoning: true,
			thinkingFormat: "deepseek",
			contextWindow: 330000,
			maxOutput: 128000,
		},
	},
	qoder: {
		smodel: { vision: true, reasoning: true, contextWindow: 200000 },
		cmodel: { vision: true, reasoning: true, contextWindow: 200000 },
		dmodel: { vision: true, contextWindow: 200000 },
		kmodel: { vision: true, contextWindow: 200000 },
		qmodel_38max: { vision: true, contextWindow: 200000 },
		gmodel: { vision: true, contextWindow: 200000 },
	},
	// glm-5.3-flash on OpenCode Go is served by a backend that rejects the z.ai
	// `thinking` object (400: unknown field "thinking") and wants reasoning_effort.
	// Overrides the global entry, whose z.ai shape is correct for z.ai itself.
	"opencode-go": {
		"mimo-v2.5": {
			vision: true,
			reasoning: true,
			thinkingFormat: "deepseek",
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
		"glm-5.3-flash": {
			vision: true,
			videoInput: true,
			pdf: true,
			reasoning: true,
			thinkingFormat: "openai",
			thinkingCanDisable: false,
			contextWindow: 1000000,
			maxOutput: 128000,
		},
		// OpenCode Go's claude-haiku-5-5 rejects `thinking.type.enabled` — the shape the
		// global *claude*haiku* → claude-budget pattern sends — with 400: `"thinking.type.enabled"
		// is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"`.
		// claude-adaptive emits exactly that (adaptive switch + output_config.effort), so override
		// the global haiku pattern for this provider only. Limits follow the model, not the
		// pattern: the upstream catalog reports context_length 1000000 and the synced catalog
		// maxOutput 128000 for this id (the provider override short-circuits before the
		// catalog overlay, so maxOutput must be stated here too).
		"claude-haiku-5-5": {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "claude-adaptive",
			contextWindow: 1000000,
			maxOutput: 128000,
		},
	},
	// GitHub Copilot routes Claude to its Anthropic-native /v1/messages shim, which applies
	// Anthropic's per-model thinking rules. claude-haiku-5.5 is adaptive-only there too: the
	// budget shape the global *claude*haiku* pattern sends comes back 400 "thinking.type.enabled"
	// is not supported for this model (live probe). Limits are stated because this override
	// short-circuits the catalog overlay; they match the synced catalog's github entry.
	github: {
		"claude-haiku-5.5": {
			vision: true,
			pdf: true,
			reasoning: true,
			search: true,
			thinkingFormat: "claude-adaptive",
			contextWindow: 1000000,
			maxOutput: 128000,
		},
	},
	commandcode: {
		// The generic commandcode fallback (1M/384k for every unlisted model) happened
		// to give haiku-5-5 the right context by accident. Pin it to the catalog values:
		// GET https://api.commandcode.ai/provider/v1/models reports context_length 1000000
		// for this id (claude-haiku-4-5-20251001 is 200000, so the 1M is per-model, not
		// gateway-wide) — and the synced catalog carries maxOutput 128000.
		"claude-haiku-5-5": {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "commandcode",
			thinkingEffortSupported: true,
			contextWindow: 1000000,
			maxOutput: 128000,
		},
	},
	codex: {
		"gpt-6-astra": {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 272000,
			maxOutput: 128000,
		},
		"gpt-6-sol": {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 272000,
			maxOutput: 128000,
		},
		// codex-rs/models-manager/models.json: gpt-6.1-terra has context_window 500000 on Codex
		// (the API model is 1.05M; Codex caps the default window like its siblings).
		"gpt-6.1-terra": {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 500000,
			maxOutput: 128000,
		},
		"gpt-6-luna": {
			vision: true,
			reasoning: true,
			search: true,
			thinkingFormat: "openai",
			contextWindow: 272000,
			maxOutput: 128000,
		},
		"gpt-6-astra[1m]": CODEX_EXTENDED_CAPS,
		"gpt-6-sol[1m]": CODEX_EXTENDED_CAPS,
		"gpt-6-luna[1m]": CODEX_EXTENDED_CAPS,
		"gpt-5.6-sol[1m]": CODEX_EXTENDED_CAPS,
		"gpt-5.6-terra[1m]": CODEX_EXTENDED_CAPS,
		"gpt-5.6-luna[1m]": CODEX_EXTENDED_CAPS,
		"gpt-5.6-sol": CODEX_GPT_56_SOL_CAPS,
		"gpt-5.6-sol-review": CODEX_GPT_56_SOL_CAPS,
		"gpt-5.6-terra": CODEX_GPT_56_DEFAULT_CAPS,
		"gpt-5.6-terra-review": CODEX_GPT_56_DEFAULT_CAPS,
		"gpt-5.6-luna": CODEX_GPT_56_DEFAULT_CAPS,
		"gpt-5.6-luna-review": CODEX_GPT_56_DEFAULT_CAPS,
	},
	kiro: {
		"gpt-5.6-sol": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-terra": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-luna": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-sol-thinking": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-terra-thinking": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-luna-thinking": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-sol-agentic": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-terra-agentic": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-luna-agentic": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-sol-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-terra-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
		"gpt-5.6-luna-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
	},
	"devin-cli": {
		"gpt-5.4-high": DEVIN_CLI_GPT_CAPS,
		"gpt-5.4-medium": DEVIN_CLI_GPT_CAPS,
		"gpt-5.4-low": DEVIN_CLI_GPT_CAPS,
		"gpt-5.5-xhigh": DEVIN_CLI_GPT_CAPS,
		"gpt-5.5-high": DEVIN_CLI_GPT_CAPS,
		"gpt-5.5-medium": DEVIN_CLI_GPT_CAPS,
		"gpt-5.5-low": DEVIN_CLI_GPT_CAPS,
	},
}
