import * as api from "../../api/client.js"
import { showStatus } from "../../utils/display.js"
import { getEndpoint } from "../../utils/endpoint.js"
import { confirm, pause, select } from "../../utils/input.js"
import { showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"

import { COLORS, getFirstApiKey } from "./shared.js"

// ─── Codex CLI ────────────────────────────────────────────────────────────────

/**
 * Build header showing current Codex config status
 * @returns {Promise<string>}
 */
async function buildCodexHeader() {
	const result = await api.getCliToolSettings("codex")
	if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`

	const { installed, has9Router, config } = result.data
	if (!installed) return `Status:   ${COLORS.red}✗ Codex CLI not installed${COLORS.reset}`

	if (!has9Router) {
		return [
			`Status:   ${COLORS.red}✗ Not configured${COLORS.reset}`,
			`${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`,
		].join("\n")
	}

	// Parse base_url and model from raw TOML string
	const baseUrlMatch = config && config.match(/base_url\s*=\s*"([^"]+)"/)
	const modelMatch = config && config.match(/^model\s*=\s*"([^"]+)"/m)
	const baseUrl = baseUrlMatch ? baseUrlMatch[1] : ""
	const model = modelMatch ? modelMatch[1] : ""

	const lines = [`Status:   ${COLORS.green}✓ Configured${COLORS.reset}`]
	if (baseUrl) lines.push(`Endpoint: ${COLORS.cyan}${baseUrl}${COLORS.reset}`)
	if (model) lines.push(`Model:    ${COLORS.dim}${model}${COLORS.reset}`)
	return lines.join("\n")
}

/**
 * Quick setup for Codex CLI
 * @param {number} port
 */
async function codexQuickSetup(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	// Get model selection
	const model = await selectModelFromList("Select Codex Model", "cx/claude-sonnet-4-5-20250929", {
		excludeCombos: true,
	})
	if (!model) return

	const result = await api.applyCliToolSettings("codex", { baseUrl: endpoint, apiKey, model })
	showStatus(
		result.success ? "Codex setup completed!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Reset Codex CLI settings
 */
async function codexReset() {
	const result = await api.resetCliToolSettings("codex")
	showStatus(
		result.success ? "Codex settings reset!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Codex CLI submenu
 * @param {number} port
 * @param {Array<string>} breadcrumb
 */
async function showCodexMenu(port, breadcrumb = []) {
	await showMenuWithBack({
		title: "🤖 Codex CLI Settings",
		breadcrumb,
		headerContent: buildCodexHeader,
		refresh: async () => ({}),
		items: [
			{
				label: "⚡ Quick Setup",
				action: async () => {
					await codexQuickSetup(port)
					return true
				},
			},
			{
				label: "Reset to Default",
				action: async () => {
					await codexReset()
					return true
				},
			},
		],
	})
}

// ─── Factory Droid ────────────────────────────────────────────────────────────

/**
 * Build header showing current Droid config status
 * @returns {Promise<string>}
 */
async function buildDroidHeader() {
	const result = await api.getCliToolSettings("droid")
	if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`

	const { installed, has9Router, settings } = result.data
	if (!installed) return `Status:   ${COLORS.red}✗ Factory Droid not installed${COLORS.reset}`

	if (!has9Router) {
		return [
			`Status:   ${COLORS.red}✗ Not configured${COLORS.reset}`,
			`${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`,
		].join("\n")
	}

	// Extract 9Router custom model config
	const custom = settings?.customModels?.find((m) => m.id === "custom:9Router-0")
	const lines = [`Status:   ${COLORS.green}✓ Configured${COLORS.reset}`]
	if (custom?.baseUrl) lines.push(`Endpoint: ${COLORS.cyan}${custom.baseUrl}${COLORS.reset}`)
	if (custom?.model) lines.push(`Model:    ${COLORS.dim}${custom.model}${COLORS.reset}`)
	return lines.join("\n")
}

/**
 * Quick setup for Factory Droid
 * @param {number} port
 */
async function droidQuickSetup(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	const model = await selectModelFromList("Select Droid Model", "cc/claude-sonnet-4-5-20250929", {
		excludeCombos: true,
	})
	if (!model) return

	const result = await api.applyCliToolSettings("droid", { baseUrl: endpoint, apiKey, model })
	showStatus(
		result.success ? "Factory Droid setup completed!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Reset Factory Droid settings
 */
async function droidReset() {
	const result = await api.resetCliToolSettings("droid")
	showStatus(
		result.success ? "Factory Droid settings reset!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Factory Droid submenu
 * @param {number} port
 * @param {Array<string>} breadcrumb
 */
async function showDroidMenu(port, breadcrumb = []) {
	await showMenuWithBack({
		title: "🤖 Factory Droid Settings",
		breadcrumb,
		headerContent: buildDroidHeader,
		refresh: async () => ({}),
		items: [
			{
				label: "⚡ Quick Setup",
				action: async () => {
					await droidQuickSetup(port)
					return true
				},
			},
			{
				label: "Reset to Default",
				action: async () => {
					await droidReset()
					return true
				},
			},
		],
	})
}

export { showCodexMenu, showDroidMenu }
