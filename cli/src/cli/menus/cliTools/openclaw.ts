import * as api from "../../api/client.js"
import { showStatus } from "../../utils/display.js"
import { getEndpoint } from "../../utils/endpoint.js"
import { confirm, pause, select } from "../../utils/input.js"
import { showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"

import { COLORS, getFirstApiKey } from "./shared.js"

// ─── Open Claw ────────────────────────────────────────────────────────────────

/**
 * Build header showing current OpenClaw config status
 * @returns {Promise<string>}
 */
async function buildOpenClawHeader() {
	const result = await api.getCliToolSettings("openclaw")
	if (!result.success) return `  ${COLORS.red}Failed to load settings${COLORS.reset}`

	const { installed, has9Router, settings } = result.data
	if (!installed) return `Status:   ${COLORS.red}✗ Open Claw not installed${COLORS.reset}`

	if (!has9Router) {
		return [
			`Status:   ${COLORS.red}✗ Not configured${COLORS.reset}`,
			`${COLORS.dim}Run "Quick Setup" to configure${COLORS.reset}`,
		].join("\n")
	}

	// Extract 9Router provider config
	const provider = settings?.models?.providers?.["9router"]
	const primary = settings?.agents?.defaults?.model?.primary || ""
	const model = primary.startsWith("9router/")
		? primary.replace("9router/", "")
		: provider?.models?.[0]?.id || ""
	const lines = [`Status:   ${COLORS.green}✓ Configured${COLORS.reset}`]
	if (provider?.baseUrl) lines.push(`Endpoint: ${COLORS.cyan}${provider.baseUrl}${COLORS.reset}`)
	if (model) lines.push(`Model:    ${COLORS.dim}${model}${COLORS.reset}`)
	return lines.join("\n")
}

/**
 * Quick setup for Open Claw
 * @param {number} port
 */
async function openClawQuickSetup(port) {
	const { endpoint } = await getEndpoint(port)
	const apiKey = await getFirstApiKey()

	if (!apiKey) {
		showStatus("No API keys found. Create one in API Keys menu first.", "error")
		await pause()
		return
	}

	const model = await selectModelFromList("Select OpenClaw Model", "cc/claude-sonnet-4-5-20250929", {
		excludeCombos: true,
	})
	if (!model) return

	const result = await api.applyCliToolSettings("openclaw", { baseUrl: endpoint, apiKey, model })
	showStatus(
		result.success ? "Open Claw setup completed!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Reset Open Claw settings
 */
async function openClawReset() {
	const result = await api.resetCliToolSettings("openclaw")
	showStatus(
		result.success ? "Open Claw settings reset!" : `Failed: ${result.error}`,
		result.success ? "success" : "error",
	)
	await pause()
}

/**
 * Open Claw submenu
 * @param {number} port
 * @param {Array<string>} breadcrumb
 */
async function showOpenClawMenu(port, breadcrumb = []) {
	await showMenuWithBack({
		title: "🦞 Open Claw Settings",
		breadcrumb,
		headerContent: buildOpenClawHeader,
		refresh: async () => ({}),
		items: [
			{
				label: "⚡ Quick Setup",
				action: async () => {
					await openClawQuickSetup(port)
					return true
				},
			},
			{
				label: "Reset to Default",
				action: async () => {
					await openClawReset()
					return true
				},
			},
		],
	})
}

export { showOpenClawMenu }
