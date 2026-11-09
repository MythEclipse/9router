// Extracted from cliTools.ts — CLI_TOOLS chunk 3/3. Merged back in cliTools.ts; do not import directly.
import type { CLIToolEntry } from "@/shared/constants/cliTools"

export const CLI_TOOLS_C: Record<string, CLIToolEntry> = {
	devin: {
		id: "devin",
		name: "Devin CLI",
		image: "/providers/devin-cli.png",
		color: "#6366F1",
		description: "Cognition Devin CLI — local binary called by the Devin CLI provider via ACP/stdio",
		configType: "guide",
		installUrl: "https://cli.devin.ai",
		notes: [
			{
				type: "info",
				text:
					"This is a local dependency, not a routed CLI. The Devin CLI provider spawns `devin acp --agent-type summarizer` and relays its output.",
			},
			{
				type: "warning",
				text:
					"Install the Devin CLI and run `devin auth login` — without it, the provider returns a spawn error on first request.",
			},
		],
		guideSteps: [
			{
				step: 1,
				title: "Install Devin CLI",
				desc: "Install via the official installer at cli.devin.ai.",
				docsUrl: "https://cli.devin.ai",
			},
			{
				step: 2,
				title: "Authenticate",
				desc: "Log in once so the binary stores its own credentials.",
			},
			{
				step: 3,
				title: "Use the provider",
				desc: "Pick any Devin CLI model under the Providers tab — no API key field needed.",
			},
		],
		codeBlock: {
			language: "bash",
			code: `# Install Devin CLI (see https://cli.devin.ai for options)
devin auth login

# Verify detection (optional)
devin --version`,
		},
	},
	opendesign: {
		id: "opendesign",
		name: "OpenDesign",
		image: "/providers/opendesign.png",
		color: "#7C3AED",
		description: "OpenDesign — claude.ai/design open-sourced! Agent-native design skills pack",
		docsUrl: "https://github.com/manalkaff/opendesign",
		configType: "guide",
		notes: [
			{
				type: "info",
				text:
					"OpenDesign ships as a plugin/skills pack installed into Claude Code, Cursor, OpenAI Codex, Gemini CLI, or OpenCode. It inherits the host agent's model config, so once your host points at 9Router, /opendesign design sessions route through 9Router automatically — no extra env vars needed.",
			},
			{
				type: "info",
				text:
					"Invoke with /opendesign <brief>. Covers decks, wireframes, interactive prototypes, design-system extraction, and brand systems, with a verifier subagent that checks output against the brief.",
			},
		],
		guideSteps: [
			{
				step: 1,
				title: "Install the plugin",
				desc: "Pick your host below and run the matching install command from the matrix.",
			},
			{
				step: 2,
				title: "No config needed",
				desc:
					"OpenDesign runs inside your host agent and uses its model config. If the host already routes through 9Router, /opendesign traffic does too.",
			},
			{
				step: 3,
				title: "Start designing",
				desc: "Invoke OpenDesign from your agent:",
				value: "/opendesign make a pitch deck for a seed-stage AI company, 10 slides",
				copyable: true,
			},
		],
		codeBlock: {
			language: "bash",
			code: `# Claude Code
/plugin marketplace add manalkaff/opendesign
/plugin install opendesign@opendesign

# Cursor
/add-plugin opendesign

# OpenAI Codex CLI
/plugins   # search "opendesign" -> Install Plugin

# OpenAI Codex App
# Plugins sidebar -> OpenDesign (Design section) -> +

# Gemini CLI
gemini extensions install https://github.com/manalkaff/opendesign

# OpenCode
# Fetch and follow .opencode/INSTALL.md from the repo`,
		},
	},
	pi: {
		id: "pi",
		name: "Pi (pi-coding-agent)",
		image: "/providers/pi.svg",
		color: "#6366F1",
		description: "Pi coding agent — minimal, extensible agent harness (pi.dev)",
		configType: "custom",
		docsUrl: "https://pi.dev",
		notes: [
			{
				type: "info",
				text:
					"Pi uses ~/.pi/agent/models.json. 9Router is configured under providers.9router as an OpenAI-compatible endpoint.",
			},
		],
	},
	omp: {
		id: "omp",
		name: "Oh My Pi",
		image: "/providers/omp.png",
		color: "#EC4899",
		description: "Oh My Pi terminal AI agent with auto-discovery support",
		configType: "custom",
		docsUrl: "https://github.com/can1357/oh-my-pi",
		notes: [
			{
				type: "info",
				text:
					"Oh My Pi uses ~/.omp/agent/models.yml and agent.db. 9Router is configured with proxy discovery so all models appear automatically under /model.",
			},
		],
	},
	crush: {
		id: "crush",
		name: "Crush",
		image: "/providers/crush.png",
		color: "#FB923C",
		description: "Charm Crush terminal AI coding agent",
		configType: "custom",
		docsUrl: "https://github.com/charmbracelet/crush",
		notes: [
			{
				type: "info",
				text: "Crush uses ~/.config/crush/crush.json. 9Router registers as an openai-compat provider.",
			},
		],
	},
	forge: {
		id: "forge",
		name: "ForgeCode",
		image: "/providers/forge.png",
		color: "#EAB308",
		description: "Antinomy HQ ForgeCode agent harness",
		configType: "custom",
		docsUrl: "https://github.com/antinomyhq/forge",
		notes: [
			{
				type: "info",
				text:
					"ForgeCode uses ~/.forge/config.toml. 9Router updates the [openai] section with your baseUrl, apiKey, and model.",
			},
		],
	},
	smelt: {
		id: "smelt",
		name: "Smelt",
		image: "/providers/smelt.svg",
		color: "#EF4444",
		description: "Smelt terminal AI coding assistant",
		configType: "custom",
		docsUrl: "https://github.com/leonardcser/smelt",
		notes: [
			{
				type: "info",
				text: "Smelt uses ~/.smelt/config.json for OpenAI-compatible endpoint configuration.",
			},
		],
	},
	codewhale: {
		id: "codewhale",
		name: "CodeWhale",
		image: "/providers/codewhale.svg",
		color: "#4F46E5",
		description: "CodeWhale terminal coding agent (successor to DeepSeek TUI)",
		configType: "custom",
		docsUrl: "https://github.com/Hmbown/CodeWhale",
		notes: [
			{
				type: "info",
				text:
					"CodeWhale uses ~/.codewhale/config.toml. 9Router configures the [openai] provider with your base_url, api_key, and model.",
			},
		],
	},
	// HIDDEN: gemini-cli
	// "gemini-cli": {
	//   id: "gemini-cli",
	//   name: "Gemini CLI",
	//   icon: "terminal",
	//   color: "#4285F4",
	//   description: "Google Gemini CLI",
	//   configType: "env",
	//   envVars: {
	//     baseUrl: "GEMINI_API_BASE_URL",
	//     model: "GEMINI_MODEL",
	//   },
	//   defaultModels: [
	//     { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", alias: "pro" },
	//     { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", alias: "flash" },
	//   ],
	// },
}
