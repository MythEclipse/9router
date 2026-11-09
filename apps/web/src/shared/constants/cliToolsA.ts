// Extracted from cliTools.ts — CLI_TOOLS chunk 1/3. Merged back in cliTools.ts; do not import directly.
import type { CLIToolEntry } from "@/shared/constants/cliTools"

export const CLI_TOOLS_A: Record<string, CLIToolEntry> = {
	claude: {
		id: "claude",
		name: "Claude Code",
		image: "/providers/claude.png",
		color: "#D97757",
		description: "Anthropic Claude Code CLI",
		configType: "env",
		envVars: {
			baseUrl: "ANTHROPIC_BASE_URL",
			model: "ANTHROPIC_MODEL",
			opusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
			sonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
			fableModel: "ANTHROPIC_DEFAULT_FABLE_MODEL",
			haikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
		},
		modelAliases: ["default", "sonnet", "opus", "fable", "haiku", "opusplan"],
		settingsFile: "~/.claude/settings.json",
		defaultModels: [
			{
				id: "fable",
				name: "Claude Fable",
				alias: "fable",
				envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL",
				defaultValue: "cc/claude-fable-5",
			},
			{
				id: "opus",
				name: "Claude Opus",
				alias: "opus",
				envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
				defaultValue: "cc/claude-opus-5",
			},
			{
				id: "sonnet",
				name: "Claude Sonnet",
				alias: "sonnet",
				envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
				defaultValue: "cc/claude-sonnet-5",
			},
			{
				id: "haiku",
				name: "Claude Haiku",
				alias: "haiku",
				envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
				defaultValue: "cc/claude-haiku-4-5-20251001",
			},
		],
	},
	openclaw: {
		id: "openclaw",
		name: "Open Claw",
		image: "/providers/openclaw.png",
		color: "#FF6B35",
		description: "Open Claw AI Assistant",
		configType: "custom",
	},
	codex: {
		id: "codex",
		name: "OpenAI Codex CLI / App",
		image: "/providers/codex.png",
		color: "#10A37F",
		description: "OpenAI Codex CLI",
		configType: "custom",
	},
	copilot: {
		id: "copilot",
		name: "GitHub Copilot",
		image: "/providers/copilot.png",
		color: "#1F6FEB",
		description: "GitHub Copilot in VS Code via 9Router extension",
		configType: "guide",
		docsUrl:
			"https://marketplace.visualstudio.com/items?itemName=hotrungnhan.9router-for-github-copilot",
		guideSteps: [
			{
				step: 1,
				title: "Install Extension",
				desc:
					"In VS Code, open Extensions (Ctrl+Shift+X or Cmd+Shift+X), search for '9Router for Github Copilot' and click Install.",
			},
			{
				step: 2,
				title: "Configure Server",
				desc:
					"Press Cmd+Shift+P (or Ctrl+Shift+P), run '9Router: Configure Server', then enter your Server URL and API Key:",
				value: "{{baseUrl}}",
				copyable: true,
			},
			{
				step: 3,
				title: "Select Model in Copilot Chat",
				desc:
					"Open Copilot Chat, click the model picker at the bottom → 'Manage Models...' → check the 9Router models to use.",
			},
		],
	},
	opencode: {
		id: "opencode",
		name: "OpenCode",
		image: "/providers/opencode.png",
		color: "#E87040",
		description: "OpenCode AI Terminal Assistant",
		configType: "custom",
	},
	cowork: {
		id: "cowork",
		name: "Claude Cowork",
		image: "/providers/claude.png",
		color: "#D97757",
		description: "Claude Desktop Cowork (third-party inference)",
		configType: "custom",
	},
	hermes: {
		id: "hermes",
		name: "Hermes Agent",
		image: "/providers/hermes.png",
		color: "#8B5CF6",
		description: "Nous Research self-improving AI agent",
		configType: "custom",
		// Model slots Hermes supports besides the default ("model:" block).
		// "default" is not listed — the card renders it as the main model picker.
		// Mirrors the "auxiliary" defaults in hermes_cli/config_defaults.py (Hermes 0.21.5):
		// web_extract/session_search no longer call an LLM (their leftover blocks are ignored,
		// so exposing them only invites dead config), MoA slots are preset-driven and not listed.
		roles: [
			{ id: "delegation", label: "Delegation (subagents)" },
			{ id: "vision", label: "Vision" },
			{ id: "compression", label: "Compression" },
			{ id: "title_generation", label: "Title Generation" },
			{ id: "approval", label: "Approval" },
			{ id: "skills_hub", label: "Skills Hub" },
			{ id: "mcp", label: "MCP" },
			{ id: "review", label: "Review (/review subagent)" },
			{ id: "memory_query_rewrite", label: "Memory Query Rewrite" },
			{ id: "background_review", label: "Background Review" },
			{ id: "curator", label: "Curator" },
			{ id: "monitor", label: "Monitor" },
			{ id: "tts_audio_tags", label: "TTS Audio Tags" },
			{ id: "triage_specifier", label: "Triage Specifier" },
			{ id: "kanban_decomposer", label: "Kanban Decomposer" },
			{ id: "profile_describer", label: "Profile Describer" },
			{ id: "goal_judge", label: "Goal Judge" },
		],
	},
	droid: {
		id: "droid",
		name: "Factory Droid",
		image: "/providers/droid.png",
		color: "#00D4FF",
		description: "Factory Droid AI Assistant",
		configType: "custom",
	},
	cursor: {
		id: "cursor",
		name: "Cursor",
		image: "/providers/cursor.png",
		color: "#000000",
		description: "Cursor AI Code Editor",
		configType: "guide",
		requiresExternalUrl: true,
		notes: [
			{ type: "warning", text: "Requires Cursor Pro account to use this feature." },
			{
				type: "cloudCheck",
				text:
					"Cursor routes requests through its own server, so local endpoint is not supported. Please enable Tunnel or Cloud Endpoint in Settings.",
			},
		],
		guideSteps: [
			{ step: 1, title: "Open Settings", desc: "Go to Settings → Models" },
			{ step: 2, title: "Enable OpenAI API", desc: 'Enable "OpenAI API key" option' },
			{ step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
			{ step: 4, title: "API Key", type: "apiKeySelector" },
			{ step: 5, title: "Add Custom Model", desc: 'Click "View All Model" → "Add Custom Model"' },
			{ step: 6, title: "Select Model", type: "modelSelector" },
		],
	},
	cline: {
		id: "cline",
		name: "Cline",
		image: "/providers/cline.png",
		color: "#5B9BD5",
		description: "Cline AI Coding Assistant",
		configType: "custom",
	},
	kilo: {
		id: "kilo",
		name: "Kilo Code",
		image: "/providers/kilocode.png",
		color: "#FF6B6B",
		description: "Kilo Code AI Assistant",
		configType: "custom",
	},
	roo: {
		id: "roo",
		name: "Roo",
		image: "/providers/roo.png",
		color: "#FF6B6B",
		description: "Roo AI Assistant",
		configType: "guide",
		guideSteps: [
			{ step: 1, title: "Open Settings", desc: "Go to Roo Settings panel" },
			{ step: 2, title: "Select Provider", desc: "Choose API Provider → Ollama" },
			{ step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
			{ step: 4, title: "API Key", type: "apiKeySelector" },
			{ step: 5, title: "Select Model", type: "modelSelector" },
		],
	},
	continue: {
		id: "continue",
		name: "Continue",
		image: "/providers/continue.png",
		color: "#7C3AED",
		description: "Continue AI Assistant",
		configType: "guide",
		guideSteps: [
			{ step: 1, title: "Open Config", desc: "Open Continue configuration file" },
			{ step: 2, title: "API Key", type: "apiKeySelector" },
			{ step: 3, title: "Select Model", type: "modelSelector" },
			{
				step: 4,
				title: "Add Model Config",
				desc: "Add the following configuration to your models array:",
			},
		],
		codeBlock: {
			language: "json",
			code: `{
  "apiBase": "{{baseUrl}}",
  "title": "{{model}}",
  "model": "{{model}}",
  "provider": "openai",
  "apiKey": "{{apiKey}}"
}`,
		},
	},
	amp: {
		id: "amp",
		name: "Amp CLI",
		image: "/providers/amp.png",
		color: "#F97316",
		description: "Sourcegraph Amp coding assistant CLI",
		docsUrl: "/docs?section=cli-tools&tool=amp",
		configType: "guide",
		defaultCommand: "amp",
		modelAliases: ["g25p", "g25f", "cs45", "g54"],
		notes: [
			{
				type: "info",
				text:
					"Use 9Router model aliases to keep Amp shorthand mappings stable across provider updates.",
			},
			{
				type: "warning",
				text:
					"Suggested shorthand examples: g25p → gemini/gemini-2.5-pro, g25f → gemini/gemini-2.5-flash, cs45 → cc/claude-sonnet-4-5-20250929.",
			},
		],
		guideSteps: [
			{
				step: 1,
				title: "Install Amp",
				desc: "Install the Amp CLI using the package manager supported by your environment.",
			},
			{ step: 2, title: "API Key", type: "apiKeySelector" },
			{ step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
			{ step: 4, title: "Select Model", type: "modelSelector" },
			{
				step: 5,
				title: "Add Shorthands",
				desc: "Map Amp shorthand names such as g25p or cs45 to 9Router aliases in your local config.",
			},
		],
		codeBlock: {
			language: "bash",
			code: `export OPENAI_API_KEY="{{apiKey}}"
export OPENAI_BASE_URL="{{baseUrl}}"
amp --model "{{model}}"
# Example shorthand aliases you can map locally:
# g25p -> gemini/gemini-2.5-pro
# cs45 -> cc/claude-sonnet-4-5-20250929`,
		},
	},
}
