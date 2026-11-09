// Extracted from cliTools.ts — CLI_TOOLS chunk 2/3. Merged back in cliTools.ts; do not import directly.
import type { CLIToolEntry } from "@/shared/constants/cliTools"

export const CLI_TOOLS_B: Record<string, CLIToolEntry> = {
	qwen: {
		id: "qwen",
		name: "Qwen Code",
		image: "/providers/qwen.png",
		color: "#10B981",
		description: "Alibaba Qwen Code CLI — supports OpenAI, Anthropic & Gemini providers via 9Router",
		docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
		configType: "guide",
		defaultCommand: "qwen",
		notes: [
			{
				type: "info",
				text:
					"Qwen Code supports multiple provider types (openai, anthropic, gemini) via modelProviders in settings.json. 9Router works as an OpenAI-compatible endpoint.",
			},
			{
				type: "info",
				text:
					"Any model available in 9Router can be used — not just Qwen models. Select from Qwen, Claude, Gemini, GPT, and more.",
			},
			{
				type: "warning",
				text:
					"Config path: Linux/macOS ~/.qwen/settings.json • Windows %USERPROFILE%\\.qwen\\settings.json",
			},
			{
				type: "error",
				text:
					"Qwen OAuth free tier was discontinued on 2026-04-15. Use 9Router with alicode/openrouter/anthropic/gemini providers instead.",
			},
		],
		modelAliases: [
			"coder-model",
			"qwen3-coder-plus",
			"qwen3-coder-flash",
			"vision-model",
			"claude-sonnet-4-6",
			"claude-opus-4-6-thinking",
			"gemini-3-flash",
			"gemini-3.1-pro-high",
		],
		defaultModels: [
			{
				id: "coder-model",
				name: "Coder Model (Qwen 3.6 Plus)",
				alias: "coder-model",
				envKey: "OPENAI_MODEL",
				defaultValue: "coder-model",
				isTopLevel: true,
			},
			{
				id: "qwen3-coder-plus",
				name: "Qwen 3 Coder Plus",
				alias: "qwen3-coder-plus",
				envKey: "OPENAI_MODEL",
				defaultValue: "qwen3-coder-plus",
			},
			{
				id: "qwen3-coder-flash",
				name: "Qwen 3 Coder Flash",
				alias: "qwen3-coder-flash",
				envKey: "OPENAI_MODEL",
				defaultValue: "qwen3-coder-flash",
			},
			{
				id: "vision-model",
				name: "Vision Model (Multimodal)",
				alias: "vision-model",
				envKey: "OPENAI_MODEL",
				defaultValue: "vision-model",
			},
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				alias: "claude-sonnet-4-6",
				envKey: "OPENAI_MODEL",
				defaultValue: "claude-sonnet-4-6",
			},
			{
				id: "claude-opus-4-6-thinking",
				name: "Claude Opus 4.6 Thinking",
				alias: "claude-opus-4-6-thinking",
				envKey: "OPENAI_MODEL",
				defaultValue: "claude-opus-4-6-thinking",
			},
			{
				id: "gemini-3.1-pro-high",
				name: "Gemini 3.1 Pro High",
				alias: "gemini-3.1-pro-high",
				envKey: "OPENAI_MODEL",
				defaultValue: "gemini-3.1-pro-high",
			},
			{
				id: "gemini-3-flash",
				name: "Gemini 3 Flash",
				alias: "gemini-3-flash",
				envKey: "OPENAI_MODEL",
				defaultValue: "gemini-3-flash",
			},
		],
		guideSteps: [
			{ step: 1, title: "Install Qwen Code", desc: "npm install -g @qwen-code/qwen-code" },
			{ step: 2, title: "API Key", type: "apiKeySelector" },
			{ step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
			{ step: 4, title: "Select Model", type: "modelSelector" },
			{
				step: 5,
				title: "Save Config",
				desc: "Copy the JSON below to your ~/.qwen/settings.json file.",
			},
		],
		codeBlock: {
			language: "json",
			code: `{
  "security": {
    "auth": {
      "selectedType": "openai",
      "apiKey": "{{apiKey}}",
      "baseUrl": "{{baseUrl}}"
    }
  },
  "model": {
    "name": "{{model}}"
  }
}`,
		},
	},
	"deepseek-tui": {
		id: "deepseek-tui",
		name: "DeepSeek TUI",
		image: "/providers/deepseek-tui.png",
		color: "#4D6BFE",
		description: "DeepSeek Terminal Coding Agent (Rust TUI)",
		docsUrl: "https://github.com/DeepSeek-TUI/DeepSeek-TUI",
		configType: "custom",
		defaultCommand: "deepseek",
		modelAliases: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
		defaultModels: [
			{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", alias: "deepseek-v4-pro" },
			{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", alias: "deepseek-v4-flash" },
			{ id: "deepseek-chat", name: "DeepSeek V3 Chat", alias: "deepseek-chat" },
		],
		notes: [
			{
				type: "info",
				text:
					"DeepSeek TUI uses ~/.deepseek/config.toml for configuration. 9Router will update the provider to 'openai' mode with your base_url, api_key, and model.",
			},
			{
				type: "warning",
				text:
					"Config path: Linux/macOS ~/.deepseek/config.toml • Windows %USERPROFILE%\\.deepseek\\config.toml",
			},
		],
	},
	jcode: {
		id: "jcode",
		name: "jcode",
		image: "/providers/jcode.png",
		color: "#FF6B35",
		description: "High-performance Rust-based coding agent harness",
		configType: "custom",
		docsUrl: "https://github.com/1jehuang/jcode",
		notes: [
			{
				type: "info",
				text:
					"jcode is a Rust-based coding agent with semantic memory, multi-agent swarms, and extreme performance (27.8 MB RAM, 14ms boot).",
			},
			{
				type: "info",
				text:
					"Configure 9router as an OpenAI-compatible provider to route all jcode requests through 9router's optimization layer.",
			},
			{
				type: "warning",
				text:
					"Requires jcode installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
			},
		],
		defaultModels: [
			{ id: "claude-opus-5", name: "Claude Opus 5", alias: "opus", defaultValue: "cc/claude-opus-5" },
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				alias: "sonnet",
				defaultValue: "cc/claude-sonnet-4-6",
			},
			{ id: "gpt-6.1-sol", name: "GPT 6.1 Sol", alias: "gpt6", defaultValue: "cx/gpt-6.1-sol" },
			{
				id: "gemini-3.1-pro",
				name: "Gemini 3.1 Pro",
				alias: "gemini",
				defaultValue: "gemini/gemini-3.1-pro",
			},
		],
	},
	"grok-build": {
		id: "grok-build",
		name: "Grok Build",
		image: "/providers/grok-cli.png",
		color: "#1DA1F2",
		description: "xAI Grok Build TUI coding agent",
		configType: "custom",
		docsUrl: "https://x.ai/cli",
		defaultCommand: "grok",
		notes: [
			{
				type: "info",
				text:
					"Grok Build uses ~/.grok/config.toml. 9Router writes a [model.9router] custom model and sets it as the default.",
			},
			{
				type: "info",
				text:
					"After Apply, run grok (or /model 9router) to use the routed model. Switch back anytime with /model grok-build.",
			},
			{
				type: "warning",
				text:
					"Config path: Linux/macOS ~/.grok/config.toml • Windows %USERPROFILE%\\.grok\\config.toml",
			},
		],
	},
}
