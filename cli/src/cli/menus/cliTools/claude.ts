import * as api from "../../api/client.js"
import { showStatus } from "../../utils/display.js"
import { getEndpoint } from "../../utils/endpoint.js"
import { confirm, pause, select } from "../../utils/input.js"
import { showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"

import { CLAUDE_MODEL_TYPES, COLORS, getFirstApiKey } from "./shared.js"

// ─── Claude Code ──────────────────────────────────────────────────────────────

/**
 * Build header showing current Claude config status
 * @returns {Promise<string>}
 */
async function buildClaudeHeader() {
	const result = await api.getCliToolSettings("claude")
	if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`

	const settings = result.data.settings
	const currentUrl = settings?.env?.ANTHROPIC_BASE_URL
	const currentKey = settings?.env?.ANTHROPIC_AUTH_TOKEN
	const lines = []

	if (currentUrl) {
		lines.push(`Status:   ${COLORS.green}✓ Configured${COLORS.reset}`)
		lines.push(`Endpoint: ${COLORS.cyan}${currentUrl}${COLORS.reset}`)
		if (currentKey) {
			lines.push(`API Key:  ${COLORS.dim}${currentKey.substring(0, 10)}...${COLORS.reset}`)
		}
	} else {
		lines.push(`Status:   ${COLORS.red}✗ Not configured${COLORS.reset}`)
		lines.push(`${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`)
	}

	return lines.join("\n")
}

/**
 * Get current Claude model from settings
 * @param {string} envKey
 * @returns {Promise<string>}
 */
async function getClaudeModel(envKey) {
	const result = await api.getCliToolSettings("claude")
	return result.success ? result.data.settings?.env?.[envKey] || "Not set" : "Not set"
}

/**
 * Quick setup for Claude Code — sets endpoint, key, and all default models
 * @param {number} port
 */
async function claudeQuickSetup(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	const env = {
		ANTHROPIC_BASE_URL: endpoint,
		ANTHROPIC_AUTH_TOKEN: apiKey,
		API_TIMEOUT_MS: "600000",
	}
	CLAUDE_MODEL_TYPES.forEach((t) => {
		env[t.envKey] = t.defaultValue
	})

	const result = await api.applyCliToolSettings("claude", { env })
	showStatus(
		result.success ? "Quick Setup completed!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Select and save a specific Claude model type
 * @param {Object} modelType
 * @param {number} port
 */
async function claudeSelectModel(modelType, port) {
	const current = await getClaudeModel(modelType.envKey)
	const selected = await selectModelFromList(`Select ${modelType.name} Model`, current, {
		excludeCombos: true,
	})
	if (!selected) return

	const env = { [modelType.envKey]: selected }

	// Also set base URL if not configured yet
	const settingsResult = await api.getCliToolSettings("claude")
	if (!settingsResult.data?.settings?.env?.ANTHROPIC_BASE_URL) {
		const { endpoint } = await getEndpoint(port)
		const apiKey = await getFirstApiKey()
		env.ANTHROPIC_BASE_URL = endpoint
		env.API_TIMEOUT_MS = "600000"
		if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey
	}

	const result = await api.applyCliToolSettings("claude", { env })
	showStatus(
		result.success ? `${modelType.name} → ${selected} saved!` : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Reset Claude Code settings
 */
async function claudeReset() {
	const result = await api.resetCliToolSettings("claude")
	showStatus(
		result.success ? "Settings reset successfully!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Claude Code submenu
 * @param {number} port
 * @param {Array<string>} breadcrumb
 */
async function showClaudeCodeMenu(port, breadcrumb = []) {
	await showMenuWithBack({
		title: "🔧 Claude Code Settings",
		breadcrumb,
		headerContent: buildClaudeHeader,
		refresh: async () => ({
			sonnet: await getClaudeModel("ANTHROPIC_DEFAULT_SONNET_MODEL"),
			opus: await getClaudeModel("ANTHROPIC_DEFAULT_OPUS_MODEL"),
			haiku: await getClaudeModel("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
		}),
		items: [
			{
				label: "⚡ Quick Setup (recommended)",
				action: async () => {
					await claudeQuickSetup(port)
					return true
				},
			},
			{
				label: (d) => `Sonnet → ${d.sonnet}`,
				action: async () => {
					await claudeSelectModel(CLAUDE_MODEL_TYPES[0], port)
					return true
				},
			},
			{
				label: (d) => `Opus → ${d.opus}`,
				action: async () => {
					await claudeSelectModel(CLAUDE_MODEL_TYPES[1], port)
					return true
				},
			},
			{
				label: (d) => `Haiku → ${d.haiku}`,
				action: async () => {
					await claudeSelectModel(CLAUDE_MODEL_TYPES[2], port)
					return true
				},
			},
			{
				label: "Reset to Default",
				action: async () => {
					await claudeReset()
					return true
				},
			},
		],
	})
}

export { claudeQuickSetup, claudeReset, claudeSelectModel, getClaudeModel, showClaudeCodeMenu }
