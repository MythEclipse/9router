/**
 * The CLI-tool settings hosts, keyed by tool name.
 *
 * Every `*-settings` route built its own `ToolSettingsDeps` bundle inline and handed it to the
 * same three use-case calls. That works while the only caller is a Next.js route that can
 * import functions directly — but a `ToolSettingsDeps` holds `isInstalled`, `config`,
 * `sideWrites` and `sideRemovals`, so it cannot cross an oRPC boundary as input. A procedure
 * can only name a tool, and something on this side has to resolve the name to the bundle.
 *
 * That something is this table. It is also the thing the routes needed anyway: the messages
 * and the host wiring are what actually differ between twenty near-identical handlers, and
 * they were only discoverable by reading twenty files.
 *
 * Three tools are deliberately absent — `devin`, `hermes` and `cowork` do not use a
 * `ToolConfigPort` at all and do their own filesystem work inline. They need use-case
 * extraction before they can be named here; an entry that guessed at their shape would lie.
 */
import type { ToolSettingsDeps } from "9router-api/application/cli-tools/manage-tool-settings"
import {
	clineSettingsConfig,
	codewhaleSettingsConfig,
	codexSettingsConfig,
	copilotSettingsConfig,
	crushSettingsConfig,
	deepseekTuiSettingsConfig,
	droidSettingsConfig,
	forgeSettingsConfig,
	grokBuildSettingsConfig,
	isClineInstalled,
	isCodewhaleInstalled,
	isCodexInstalled,
	isCopilotInstalled,
	isCrushInstalled,
	isDeepSeekTuiInstalled,
	isDroidInstalled,
	isForgeInstalled,
	isGrokBuildInstalled,
	isJcodeInstalled,
	isKiloInstalled,
	isOmpInstalled,
	isOpenClawInstalled,
	isOpenCodeInstalled,
	isPiInstalled,
	isSmeltInstalled,
	jcodeSettingsConfig,
	kiloSettingsConfig,
	ompSettingsConfig,
	openCodeSettingsConfig,
	openclawSettingsConfig,
	piSettingsConfig,
	removeClineSettings,
	removeCodewhaleSettings,
	removeCodexSettings,
	removeCopilotSettings,
	removeCrushSettings,
	removeDroidSettings,
	removeForgeSettings,
	removeGrokBuildSettings,
	removeJcodeEnv,
	removeOmpSettings,
	removeOpenClawSettings,
	removeOpenCodeSettings,
	removePiSettings,
	smeltSettingsConfig,
	writeClineSecret,
	writeJcodeEnv,
	writeKiloVsCodeSettings,
	writeOmpCredentials,
	writeOpenClawAgentModels,
} from "./cliToolHosts"

/**
 * The tools a procedure may name.
 *
 * A tuple so the oRPC input enum and this table cannot drift: a tool present in one and not the
 * other becomes a type error rather than a procedure that answers 404 at runtime.
 */
export const CLI_TOOL_NAMES = [
	"cline",
	"codewhale",
	"codex",
	"copilot",
	"crush",
	"deepseek-tui",
	"droid",
	"forge",
	"grok-build",
	"jcode",
	"kilo",
	"omp",
	"openclaw",
	"opencode",
	"pi",
	"smelt",
] as const

export type CliToolName = (typeof CLI_TOOL_NAMES)[number]

/**
 * Each tool's host bundle, built lazily.
 *
 * `deps` returns a fresh object per call: the side-write and side-removal arrays are
 * per-invocation lists, and sharing one would let a later caller observe an earlier one's
 * entries.
 */
const HOSTS: Readonly<Record<CliToolName, () => ToolSettingsDeps>> = {
	cline: () => ({
		isInstalled: isClineInstalled,
		config: clineSettingsConfig,
		// Cline keeps the provider choice in `globalState.json` and the key in `secrets.json`.
		sideWrites: [(input) => writeClineSecret(input.apiKey)],
		sideRemovals: [removeClineSettings],
		notInstalledMessage: "Cline CLI is not installed",
		appliedMessage: "Cline settings applied successfully!",
		resetMessage: "9Router settings removed from Cline",
	}),

	codewhale: () => ({
		isInstalled: isCodewhaleInstalled,
		config: codewhaleSettingsConfig,
		sideRemovals: [removeCodewhaleSettings],
		notInstalledMessage: "CodeWhale CLI is not installed",
		appliedMessage: "CodeWhale settings applied successfully!",
		resetMessage: "9Router removed from CodeWhale",
	}),

	codex: () => ({
		isInstalled: isCodexInstalled,
		config: codexSettingsConfig,
		sideRemovals: [removeCodexSettings],
		notInstalledMessage: "Codex CLI is not installed",
		appliedMessage: "Codex settings applied successfully!",
		resetMessage: "9Router settings removed successfully",
	}),

	copilot: () => ({
		isInstalled: isCopilotInstalled,
		config: copilotSettingsConfig,
		sideRemovals: [removeCopilotSettings],
		// The operator is told VS Code is missing, not "Copilot": the settings live in VS Code.
		notInstalledMessage: "VS Code is not installed",
		appliedMessage: "Copilot settings applied! Reload VS Code to take effect.",
		resetMessage: "9Router removed from GitHub Copilot",
	}),

	crush: () => ({
		isInstalled: isCrushInstalled,
		config: crushSettingsConfig,
		sideRemovals: [removeCrushSettings],
		notInstalledMessage: "Crush CLI is not installed",
		appliedMessage: "Crush settings applied successfully!",
		resetMessage: "9Router removed from Crush",
	}),

	"deepseek-tui": () => ({
		isInstalled: isDeepSeekTuiInstalled,
		config: deepseekTuiSettingsConfig,
		notInstalledMessage: "DeepSeek TUI is not installed",
		appliedMessage: "DeepSeek TUI settings applied successfully!",
		resetMessage: "9router config reset to DeepSeek defaults",
	}),

	droid: () => ({
		isInstalled: isDroidInstalled,
		config: droidSettingsConfig,
		sideRemovals: [removeDroidSettings],
		notInstalledMessage: "Factory Droid CLI is not installed",
		appliedMessage: "Droid settings applied successfully!",
		resetMessage: "9Router settings removed from Droid",
	}),

	forge: () => ({
		isInstalled: isForgeInstalled,
		config: forgeSettingsConfig,
		sideRemovals: [removeForgeSettings],
		notInstalledMessage: "ForgeCode CLI is not installed",
		appliedMessage: "ForgeCode settings applied successfully!",
		resetMessage: "9Router removed from ForgeCode",
	}),

	"grok-build": () => ({
		isInstalled: isGrokBuildInstalled,
		config: grokBuildSettingsConfig,
		sideRemovals: [removeGrokBuildSettings],
		notInstalledMessage: "Grok Build CLI is not installed",
		appliedMessage: "Grok Build settings applied successfully!",
		resetMessage: "9router model slots removed from Grok Build",
	}),

	jcode: () => ({
		isInstalled: isJcodeInstalled,
		config: jcodeSettingsConfig,
		// The side write takes the validated form, not a bare string: it runs after the key has
		// been resolved, so it writes exactly what the config entry names.
		sideWrites: [(input) => writeJcodeEnv(input.apiKey)],
		sideRemovals: [removeJcodeEnv],
		notInstalledMessage:
			"jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
		appliedMessage: "jcode configured successfully. Use: jcode --provider-profile 9router",
		resetMessage: "9router configuration removed from jcode",
	}),

	kilo: () => ({
		isInstalled: isKiloInstalled,
		config: kiloSettingsConfig,
		sideWrites: [(input) => writeKiloVsCodeSettings(input)],
		sideRemovals: [() => writeKiloVsCodeSettings({ baseUrl: "", apiKey: "", model: "" }, true)],
		notInstalledMessage: "Kilo Code CLI is not installed",
		appliedMessage: "Kilo Code settings applied successfully!",
		resetMessage: "9Router settings removed from Kilo Code",
	}),

	omp: () => ({
		isInstalled: isOmpInstalled,
		config: ompSettingsConfig,
		sideWrites: [writeOmpCredentials],
		sideRemovals: [removeOmpSettings],
		notInstalledMessage: "Oh My Pi is not installed",
		appliedMessage: "Oh My Pi settings applied! Run 'omp' and 9Router models appear under 9router.",
		resetMessage: "9Router removed from Oh My Pi",
	}),

	openclaw: () => ({
		isInstalled: isOpenClawInstalled,
		config: openclawSettingsConfig,
		sideWrites: [writeOpenClawAgentModels],
		sideRemovals: [removeOpenClawSettings],
		notInstalledMessage: "Open Claw CLI is not installed",
		appliedMessage: "Open Claw settings applied successfully!",
		resetMessage: "9Router settings removed from Open Claw",
	}),

	opencode: () => ({
		isInstalled: isOpenCodeInstalled,
		config: openCodeSettingsConfig,
		sideRemovals: [removeOpenCodeSettings],
		notInstalledMessage: "OpenCode CLI is not installed",
		appliedMessage: "OpenCode settings applied successfully!",
		resetMessage: "9Router settings removed from OpenCode",
	}),

	pi: () => ({
		isInstalled: isPiInstalled,
		config: piSettingsConfig,
		sideRemovals: [removePiSettings],
		notInstalledMessage: "Pi CLI is not installed",
		appliedMessage: "Pi settings applied! Use /model in Pi to select the 9Router model.",
		resetMessage: "9Router removed from Pi",
	}),

	smelt: () => ({
		isInstalled: isSmeltInstalled,
		config: smeltSettingsConfig,
		// Smelt keeps one flat file and owns no second store, so reset is the config port's job.
		notInstalledMessage: "Smelt CLI is not installed",
		appliedMessage: "Smelt settings applied successfully!",
		resetMessage: "Smelt 9Router settings removed",
	}),
}

/** True when a tool name is one this install can configure. */
export function isCliToolName(value: string): value is CliToolName {
	return Object.hasOwn(HOSTS, value)
}

/**
 * The host bundle for a tool, or `undefined` when the name is not one of the sixteen.
 *
 * Returns `undefined` rather than throwing: the caller decides whether an unknown name is a
 * 404 (the HTTP route) or a validation failure (the procedure, which validates first).
 */
export function cliToolHost(name: string): ToolSettingsDeps | undefined {
	return isCliToolName(name) ? HOSTS[name]() : undefined
}
